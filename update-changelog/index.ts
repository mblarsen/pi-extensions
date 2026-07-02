import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { Container, SelectList, type SelectItem, Text, Spacer, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const NPM_REGISTRY = "https://registry.npmjs.org";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours cooldown

interface PackageUpdate {
  displayName: string;
  source: string;
  type: "npm" | "git";
  currentVersion: string;
  latestVersion: string;
  installPath?: string;
  detailsStatus: "idle" | "loading" | "done" | "error";
  changelog?: string | null;
  commits?: string | null;
  repoUrl?: string | null;
  changelogFileStatus?: "idle" | "checking" | "found" | "not_found";
  changelogFileContent?: string | null;
  installedSuccess?: boolean;
  latestDate?: string | null;
  updateStatus?: "queued" | "updating" | "success" | "error";
  updateError?: string;
}

function getAgentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent");
}

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  try {
    const pubDate = new Date(dateStr);
    if (isNaN(pubDate.getTime())) return "";
    const now = new Date();
    const diffMs = now.getTime() - pubDate.getTime();
    if (diffMs < 0) return "today";
    
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return "today";
    if (diffDays === 1) return "yesterday";
    if (diffDays < 30) return `${diffDays} days ago`;
    
    const diffMonths = Math.floor(diffDays / 30.43);
    if (diffMonths < 12) {
      return diffMonths === 1 ? "1 month ago" : `${diffMonths} months ago`;
    }
    
    const diffYears = Math.floor(diffDays / 365.25);
    return diffYears === 1 ? "1 year ago" : `${diffYears} years ago`;
  } catch {
    return "";
  }
}

function getPackageAgeInDays(dateStr: string | null | undefined): number {
  if (!dateStr) return 999;
  try {
    const pubDate = new Date(dateStr);
    if (isNaN(pubDate.getTime())) return 999;
    const now = new Date();
    const diffMs = now.getTime() - pubDate.getTime();
    return diffMs / (1000 * 60 * 60 * 24);
  } catch {
    return 999;
  }
}

function parseNpmSource(source: string): { name: string; tag?: string } | null {
  const match = source.match(/^npm:(@?[^@]+)(?:@(.+))?$/);
  if (!match) return null;
  return { name: match[1], tag: match[2] };
}

function parseGitSource(source: string): { host: string; path: string; ref?: string } | null {
  const match = source.match(/^git:([^/]+)\/(.+?)(?:@(.+))?$/);
  if (!match) return null;
  return { host: match[1], path: match[2], ref: match[3] };
}

async function getInstalledVersion(packageName: string, agentDir: string): Promise<string | null> {
  try {
    const pkgJsonPath = join(agentDir, "npm", "node_modules", packageName, "package.json");
    if (!existsSync(pkgJsonPath)) return null;
    const content = await readFile(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

interface NpmLatestInfo {
  version: string | null;
  publishDate: string | null;
}

async function getLatestNpmInfo(packageName: string): Promise<NpmLatestInfo | null> {
  try {
    const encodedName = encodeURIComponent(packageName);
    const url = `${NPM_REGISTRY}/${encodedName}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const data = (await response.json()) as any;
    const latestVersion = data["dist-tags"]?.latest ?? null;
    if (!latestVersion) return null;
    const publishDate = data.time?.[latestVersion] ?? null;
    return { version: latestVersion, publishDate };
  } catch {
    return null;
  }
}

function isNewerVersion(latest: string, current: string): boolean {
  const parseV = (v: string) => {
    const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : [0, 0, 0];
  };
  const l = parseV(latest);
  const c = parseV(current);
  for (let i = 0; i < 3; i++) {
    if (l[i] !== c[i]) return l[i] > c[i];
  }
  return false;
}

function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "pi-coding-agent",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  return headers;
}

async function fetchGithubChangelogFile(ownerSlashRepo: string): Promise<string | null> {
  const branches = ["main", "master"];
  const files = ["CHANGELOG.md", "changelog.md", "CHANGELOG", "HISTORY.md", "history.md"];
  
  for (const branch of branches) {
    for (const file of files) {
      try {
        const url = `https://raw.githubusercontent.com/${ownerSlashRepo}/${branch}/${file}`;
        const res = await fetch(url, { method: "GET" });
        if (res.ok) {
          const text = await res.text();
          if (text && text.trim().length > 10) {
            return text;
          }
        }
      } catch {
        // check next combination
      }
    }
  }
  return null;
}

async function fetchLocalChangelogFile(installPath: string): Promise<string | null> {
  const files = ["CHANGELOG.md", "changelog.md", "CHANGELOG", "HISTORY.md", "history.md"];
  for (const file of files) {
    try {
      const p = join(installPath, file);
      if (existsSync(p)) {
        const text = await readFile(p, "utf-8");
        if (text && text.trim().length > 10) {
          return text;
        }
      }
    } catch {
      // check next
    }
  }
  return null;
}

async function fetchGitHubCommits(ownerRepo: string, base: string, head: string): Promise<string | null> {
  try {
    const headers = getGitHubHeaders();
    // 1. Fetch new commits (the delta between base and head)
    let compareUrl = `https://api.github.com/repos/${ownerRepo}/compare/v${base}...v${head}`;
    let compareRes = await fetch(compareUrl, { headers });
    
    if (!compareRes.ok) {
      compareUrl = `https://api.github.com/repos/${ownerRepo}/compare/${base}...${head}`;
      compareRes = await fetch(compareUrl, { headers });
    }
    
    let newCommitsStr = "";
    if (compareRes.ok) {
      const data = (await compareRes.json()) as any;
      if (data.commits && data.commits.length) {
        newCommitsStr = data.commits.reverse().map((c: any) => {
          const hash = c.sha.slice(0, 7);
          const date = c.commit.author?.date ? c.commit.author.date.slice(0, 10) : "";
          const msg = c.commit.message.split('\n')[0];
          return `${hash} ${date} ${msg}`;
        }).join('\n');
      }
    }

    // 2. Fetch old commits (historical commits starting from the base tag downwards)
    let oldUrl = `https://api.github.com/repos/${ownerRepo}/commits?sha=v${base}&per_page=15`;
    let oldRes = await fetch(oldUrl, { headers });
    
    if (!oldRes.ok) {
      oldUrl = `https://api.github.com/repos/${ownerRepo}/commits?sha=${base}&per_page=15`;
      oldRes = await fetch(oldUrl, { headers });
    }

    let oldCommitsStr = "";
    if (oldRes.ok) {
      const oldData = (await oldRes.json()) as any[];
      if (oldData && oldData.length) {
        oldCommitsStr = oldData.map((c: any) => {
          const hash = c.sha.slice(0, 7);
          const date = c.commit.author?.date ? c.commit.author.date.slice(0, 10) : "";
          const msg = c.commit.message.split('\n')[0];
          return `${hash} ${date} ${msg}`;
        }).join('\n');
      }
    }

    if (!newCommitsStr && !oldCommitsStr) return null;

    let combined = "";
    if (newCommitsStr) combined += newCommitsStr + "\n\n";
    combined += `## __COMMIT_HISTORY_SEPARATOR__`;
    if (oldCommitsStr) combined += "\n\n" + oldCommitsStr;

    return combined;
  } catch {
    return null;
  }
}

async function fetchNpmChangelog(packageName: string, version: string, installedVersion?: string): Promise<{ changelog: string | null; repoUrl: string | null }> {
  let repoUrl: string | null = null;
  try {
    const encodedName = encodeURIComponent(packageName);
    const url = `${NPM_REGISTRY}/${encodedName}/${version}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return { changelog: null, repoUrl: null };
    const data = (await response.json()) as any;

    const repo = data.repository;
    if (typeof repo === "object" && repo?.url) {
      repoUrl = repo.url.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "");
    } else if (typeof repo === "string") {
      repoUrl = repo;
    }

    if (repoUrl && repoUrl.includes("github.com")) {
      const githubMatch = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
      if (githubMatch) {
        const releases = await fetchGitHubReleases(githubMatch[1].replace(/\.git$/, ""), installedVersion);
        if (releases) return { changelog: releases, repoUrl };
      }
    }

    const readme = data.readme ?? null;
    if (readme) {
      const changelogSection = readme.match(/#{1,3}\s+changelog[\s\S]*?(?=#{1,2}\s+[A-Z]|$)/i);
      if (changelogSection) return { changelog: changelogSection[0].slice(0, 3000), repoUrl };
    }

    return { changelog: readme ? readme.slice(0, 2000) : null, repoUrl };
  } catch {
    return { changelog: null, repoUrl };
  }
}

async function fetchGitHubReleases(ownerSlashRepo: string, installedVersion?: string): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${ownerSlashRepo}/releases?per_page=15`;
    const response = await fetch(url, { headers: getGitHubHeaders() });
    if (!response.ok) return null;
    const releases = (await response.json()) as any[];
    if (!releases.length) return null;
    
    return releases.slice(0, 15).map((r: any) => {
      let title = `## ${r.tag_name} (${r.published_at?.slice(0, 10) ?? "unknown"})`;
      if (installedVersion && (r.tag_name === installedVersion || r.tag_name === `v${installedVersion}`)) {
        title += `  <-- INSTALLED VERSION`;
      }
      return `${title}\n${(r.body ?? "No release notes.").slice(0, 1000)}`;
    }).join("\n\n");
  } catch {
    return null;
  }
}

async function fetchGitChangelog(installPath: string, pi: ExtensionAPI): Promise<string | null> {
  try {
    // 1. Fetch new commits (HEAD..FETCH_HEAD)
    const newRes = await pi.exec("git", ["log", "HEAD..FETCH_HEAD", "--format=%h %cd %s", "--date=short", "--no-color"], {
      cwd: installPath,
      timeout: 10000,
    });
    
    // 2. Fetch old commits (HEAD and downwards)
    const oldRes = await pi.exec("git", ["log", "-n", "15", "--format=%h %cd %s", "--date=short", "--no-color"], {
      cwd: installPath,
      timeout: 10000,
    });

    const newCommits = newRes.code === 0 ? newRes.stdout.trim() : "";
    const oldCommits = oldRes.code === 0 ? oldRes.stdout.trim() : "";

    if (!newCommits && !oldCommits) return null;

    let combined = "";
    if (newCommits) combined += newCommits + "\n\n";
    combined += `## __COMMIT_HISTORY_SEPARATOR__`;
    if (oldCommits) combined += "\n\n" + oldCommits;

    return combined;
  } catch {
    return null;
  }
}

function formatChangelog(text: string, theme: any, showDates: boolean): string[] {
  // Convert literal backslash+n representations to real newlines and strip carriage returns
  const cleanText = text.replace(/\\n/g, "\n").replace(/\\r/g, "");
  const rawLines = cleanText.split('\n');
  const formatted: string[] = [];

  let lastLineWasEmpty = false;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const isLineEmpty = line.trim() === "";
    if (isLineEmpty) {
      if (lastLineWasEmpty) {
        continue;
      }
      lastLineWasEmpty = true;
      formatted.push("");
      continue;
    } else {
      lastLineWasEmpty = false;
    }

    if (line === "## __COMMIT_HISTORY_SEPARATOR__") {
      formatted.push("## __COMMIT_HISTORY_SEPARATOR__");
      continue;
    }

    const hashMatch = line.match(/^([a-f0-9]{7,40})(\s+)(?:(\d{4}-\d{2}-\d{2})\s+)?(.*)/);
    let hash = "";
    let rest = line;
    if (hashMatch) {
      const hashText = hashMatch[1];
      const space = hashMatch[2];
      const dateText = hashMatch[3];
      rest = hashMatch[4];

      if (dateText && showDates) {
        hash = theme.fg("muted", dateText) + " " + theme.fg("dim", hashText) + space;
      } else {
        hash = theme.fg("dim", hashText) + space;
      }
    }

    const headerMatch = rest.match(/^(#{1,6})\s+(.*)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      let content = headerMatch[2];
      
      const isInstalled = content.includes("<-- INSTALLED VERSION");
      if (isInstalled) content = content.replace(/\s*<-- INSTALLED VERSION/, "");
      if (!showDates) content = content.replace(/\s*\(\d{4}-\d{2}-\d{2}\)/, "");

      let rendered = content;
      if (level === 1) {
        rendered = theme.fg("accent", theme.bold(content));
      } else if (level === 2) {
        rendered = theme.bold(content);
      } else if (level === 3) {
        rendered = theme.fg("accent", content);
      } else {
        rendered = theme.fg("muted", content);
      }

      if (isInstalled) {
        rendered += theme.fg("warning", theme.bold("  <-- INSTALLED VERSION"));
      }

      formatted.push(hash + rendered);
      
      // Auto-inject a single blank line after every header if there is content following it
      if (i < rawLines.length - 1) {
        formatted.push("");
        lastLineWasEmpty = true;
      }
      continue;
    }

    const ccMatch = rest.match(/^([\s\-*]*)([a-zA-Z]+)(\([^)]+\))?(!)?:\s+(.*)/);
    if (ccMatch) {
      const prefix = ccMatch[1];
      const type = ccMatch[2];
      const scope = ccMatch[3] || "";
      const bang = ccMatch[4] || "";
      let msg = ccMatch[5];

      let coloredType = type;
      if (type.toLowerCase() === "fix") coloredType = theme.fg("success", type);
      else if (type.toLowerCase() === "feat") coloredType = theme.fg("accent", type);
      else coloredType = theme.fg("muted", type);

      const coloredScope = scope ? theme.fg("dim", scope) : "";
      const coloredBang = bang ? theme.bold(theme.fg("error", bang)) : "";
      msg = msg.replace(/BREAKING CHANGE/g, theme.bold(theme.fg("error", "BREAKING CHANGE")));

      rest = `${prefix}${coloredType}${coloredScope}${coloredBang}: ${msg}`;
    } else {
      rest = rest.replace(/BREAKING CHANGE/g, theme.bold(theme.fg("error", "BREAKING CHANGE")));
    }

    formatted.push(hash + rest);
  }
  
  return formatted;
}

class UpdateExplorer {
  private container = new Container();
  private mode: "loading" | "list" | "details" = "loading";
  private selectList!: SelectList;
  private selectedResult: PackageUpdate | null = null;
  private formattedLines: string[] = [];
  private scrollOffset = 0;
  private maxDetailLines = 20;

  private isUpdating = false;
  private updateQueue: PackageUpdate[] = [];
  private removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private isConfirmingUpdate = false;
  private confirmingPackage: PackageUpdate | null = null;

  private activeTab: "commits" | "releases" | "changelog" = "commits";
  private showDates = false;
  private lastKey = "";
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private spinnerIdx = 0;
  private timer: any;
  private results: PackageUpdate[] = [];
  private selectListItems: SelectItem[] = [];

  private cachedWrappedLines: string[] = [];
  private cachedInnerWidth: number = 0;
  // A minimum width the details view will try to request to stretch the auto-width container
  private minDetailsWidth: number = 80;
  private overlayOptions: any;

  public setOverlayOptions(opts: any) {
    this.overlayOptions = opts;
    this.updateOverlayWidth();
  }

  private updateOverlayWidth() {
    if (!this.overlayOptions) return;
    const termWidth = this.tui.terminal.columns || 80;
    
    if (this.mode === "loading") {
      this.overlayOptions.width = 39;
    } else if (this.mode === "details") {
      this.overlayOptions.width = Math.max(40, Math.floor(termWidth * 0.90));
    } else {
      this.overlayOptions.width = Math.max(40, Math.min(76, Math.floor(termWidth * 0.80)));
    }
  }

  constructor(
    private fetchPromise: Promise<PackageUpdate[]>,
    private pi: ExtensionAPI,
    private theme: any,
    private tui: any,
    private done: (result?: any) => void,
    private onUpdateInstalled?: (displayName: string) => void
  ) {
    this.timer = setInterval(() => {
      this.spinnerIdx = (this.spinnerIdx + 1) % this.spinnerFrames.length;
      
      const listHasLoading = this.results.some(r => r.detailsStatus === "loading");
      if (this.mode === "loading") {
        this.tui.requestRender();
      } else if (this.mode === "list" && (listHasLoading || this.isUpdating)) {
        this.updateSelectListSpinners();
        this.rebuild();
        this.tui.requestRender();
      } else if (this.mode === "details" && this.selectedResult && this.selectedResult.changelogFileStatus === "checking") {
        this.rebuild();
        this.tui.requestRender();
      }
    }, 80);

    this.fetchPromise.then(res => {
      this.results = res;
      
      if (res.length === 0) {
        this.mode = "list";
        this.rebuild();
        this.tui.requestRender();
        return;
      }

      this.buildSelectList();
      this.mode = "list";
      this.rebuild();
      this.tui.requestRender();

      // Kick off background fetching for details
      for (const r of this.results) {
        this.fetchDetails(r).then(() => {
          this.updateSelectListSpinners();
          // If we finish fetching while on the list view, trigger a re-render to clear the spinner
          if (this.mode === "list") {
            this.rebuild();
            this.tui.requestRender();
          }
          // If it finished loading and it's selected, update the view.
          if (this.selectedResult === r && this.mode === "details") {
            this.updateFormattedLines();
            this.rebuild();
            this.tui.requestRender();
          }
        });
      }

    }).catch(() => {
      this.done();
    });
    
    this.rebuild();
  }

  private async fetchDetails(update: PackageUpdate) {
    update.detailsStatus = "loading";
    try {
      if (update.type === "npm") {
        // Run fetches in parallel for speed, handle failures gracefully per-service
        const [{ changelog, repoUrl }, commits] = await Promise.all([
          fetchNpmChangelog(update.displayName, update.latestVersion, update.currentVersion),
          (async () => {
            // Need repo URL first to fetch commits, so we quickly peek at the registry again
            // (or we could extract it from package.json, but registry is fine)
            try {
              const url = `${NPM_REGISTRY}/${encodeURIComponent(update.displayName)}/latest`;
              const res = await fetch(url, { headers: { Accept: "application/json" } });
              if (!res.ok) return null;
              const data = await res.json();
              const repo = data.repository;
              let rUrl = null;
              if (typeof repo === "object" && repo?.url) rUrl = repo.url;
              else if (typeof repo === "string") rUrl = repo;
              
              if (rUrl && rUrl.includes("github.com")) {
                const match = rUrl.match(/github\.com\/([^/]+\/[^/]+)/);
                if (match) {
                   return await fetchGitHubCommits(match[1].replace(/\.git$/, ""), update.currentVersion, update.latestVersion);
                }
              }
              return null;
            } catch {
              return null;
            }
          })()
        ]);
        
        update.changelog = changelog || "No changelog found in npm readme or GitHub releases.";
        update.repoUrl = repoUrl;
        
        if (commits) {
          update.commits = commits;
        } else {
          update.commits = `No commit history available.\n\nCould not fetch commits from GitHub (repo might be private, missing, or rate limited).`;
        }
      } else {
        const commits = await fetchGitChangelog(update.installPath!, this.pi);
        if (commits) {
          update.commits = commits;
        } else {
          update.commits = "No commit history available.\n\nFailed to read local git log.";
        }
      }
    } catch (err) {
      update.changelog = "Failed to load details due to a network or parsing error.";
      update.commits = update.changelog;
    } finally {
      update.detailsStatus = "done";
    }
  }

  private async triggerLazyChangelogFileCheck(update: PackageUpdate) {
    if (update.changelogFileStatus && update.changelogFileStatus !== "idle") return;
    
    update.changelogFileStatus = "checking";
    this.rebuild();
    this.tui.requestRender();

    try {
      let content: string | null = null;
      if (update.type === "npm" && update.repoUrl) {
        const match = update.repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
        if (match) {
          const ownerRepo = match[1].replace(/\.git$/, "");
          content = await fetchGithubChangelogFile(ownerRepo);
        }
      } else if (update.type === "git" && update.installPath) {
        content = await fetchLocalChangelogFile(update.installPath);
      }

      if (content) {
        update.changelogFileContent = content;
        update.changelogFileStatus = "found";
      } else {
        update.changelogFileStatus = "not_found";
      }
    } catch {
      update.changelogFileStatus = "not_found";
    }

    // If the user is still looking at this item, update formatted lines and render
    if (this.selectedResult === update && this.mode === "details") {
      this.updateFormattedLines();
      this.rebuild();
      this.tui.requestRender();
    }
  }

  private tryPerformUpdate(update: PackageUpdate) {
    if (update.installedSuccess || update.updateStatus === "updating" || update.updateStatus === "queued") return;

    const ageInDays = getPackageAgeInDays(update.latestDate);
    if (ageInDays < 3.0) {
      this.isConfirmingUpdate = true;
      this.confirmingPackage = update;
      if (this.mode === "list") {
        this.updateSelectListSpinners();
      } else {
        this.rebuild();
      }
      this.tui.requestRender();
    } else {
      this.queueOrStartUpdate(update);
    }
  }

  private queueOrStartUpdate(update: PackageUpdate) {
    if (update.installedSuccess || update.updateStatus === "updating" || update.updateStatus === "queued") return;

    if (this.mode === "details") {
      this.mode = "list";
      this.selectedResult = null;
      this.buildSelectList();
    }

    update.updateError = undefined;
    if (this.isUpdating) {
      update.updateStatus = "queued";
      this.updateQueue.push(update);
      this.updateSelectListSpinners();
      this.rebuild();
      this.tui.requestRender();
      return;
    }

    void this.performUpdate(update);
  }

  private startNextQueuedUpdate() {
    if (this.isUpdating) return;

    while (this.updateQueue.length > 0) {
      const next = this.updateQueue.shift();
      if (!next || !this.results.includes(next) || next.installedSuccess) continue;
      next.updateStatus = undefined;
      this.queueOrStartUpdate(next);
      return;
    }
  }

  private async performUpdate(update: PackageUpdate) {
    if (this.isUpdating || update.installedSuccess) return;

    this.isUpdating = true;
    update.updateStatus = "updating";
    update.updateError = undefined;
    this.updateSelectListSpinners();
    this.rebuild();
    this.tui.requestRender();

    try {
      let res;

      try {
        // Try executing the global 'pi' binary via 'env' to override PI_OFFLINE variable
        res = await this.pi.exec("env", ["PI_OFFLINE=0", "pi", "update", "--extension", update.source], {
          timeout: 60000
        });
      } catch {
        // Fallback to absolute process.argv pathing using env
        const cliPath = (typeof process !== "undefined" && process.argv && process.argv[1]) || "pi";
        const nodeBin = (typeof process !== "undefined" && process.argv && process.argv[0]) || "node";
        
        res = await this.pi.exec("env", ["PI_OFFLINE=0", nodeBin, cliPath, "update", "--extension", update.source], {
          timeout: 60000
        });
      }

      this.isUpdating = false;

      if (res && res.code === 0) {
        update.installedSuccess = true;
        update.updateStatus = "success";
        if (this.onUpdateInstalled) {
          this.onUpdateInstalled(update.displayName);
        }
        if (this.disposed) return;
        this.updateSelectListSpinners();
        this.rebuild();
        this.tui.requestRender();

        const timer = setTimeout(() => {
          this.removalTimers.delete(update.displayName);
          this.results = this.results.filter(r => r.displayName !== update.displayName);
          if (this.selectedResult === update) {
            this.selectedResult = null;
            this.mode = "list";
          }
          
          if (this.results.length > 0) {
            this.buildSelectList();
            this.updateSelectListSpinners();
          }
          this.rebuild();
          this.tui.requestRender();
        }, 1500);
        this.removalTimers.set(update.displayName, timer);
      } else {
        const errorMsg = res ? (res.stderr || res.stdout || "Unknown error during update.") : "Unknown execution error.";
        update.updateStatus = "error";
        update.updateError = errorMsg;
        if (this.disposed) return;
        this.tui.notify(`Failed to update ${update.displayName}: ${errorMsg.slice(0, 100)}`, "error");
        this.updateSelectListSpinners();
        this.rebuild();
        this.tui.requestRender();
      }
    } catch (err: any) {
      this.isUpdating = false;
      update.updateStatus = "error";
      update.updateError = err.message;
      if (this.disposed) return;
      this.tui.notify(`Failed to update: ${err.message}`, "error");
      this.updateSelectListSpinners();
      this.rebuild();
      this.tui.requestRender();
    } finally {
      if (!this.disposed) {
        this.startNextQueuedUpdate();
      }
    }
  }

  private buildSelectList() {
    let maxVerLength = 0;
    const itemsData = this.results.map(r => {
      const verPart = r.currentVersion !== "installed" ? `v${r.currentVersion} → v${r.latestVersion}` : "Updates available";
      if (verPart.length > maxVerLength) {
        maxVerLength = verPart.length;
      }
      return { r, verPart };
    });

    const targetVerWidth = Math.max(18, maxVerLength);

    this.selectListItems = itemsData.map(({ r, verPart }) => {
      let desc = verPart.padEnd(targetVerWidth);
      const relTime = formatRelativeTime(r.latestDate);
      if (relTime) {
        desc += `  ${relTime}`;
      }
      if (r.installedSuccess) {
        return { value: r.displayName, label: `✓ ${r.displayName}`, description: `installed!` };
      }
      if (r.updateStatus === "updating") {
        return { value: r.displayName, label: `${this.spinnerFrames[this.spinnerIdx]} ${r.displayName}`, description: `Updating...` };
      }
      if (r.updateStatus === "queued") {
        return { value: r.displayName, label: `⏳ ${r.displayName}`, description: `Queued for update` };
      }
      if (r.updateStatus === "error") {
        return { value: r.displayName, label: `✗ ${r.displayName}`, description: `Failed — press u to retry` };
      }
      return { value: r.displayName, label: r.displayName, description: desc };
    });

    this.selectList = new SelectList(this.selectListItems, Math.min(this.selectListItems.length, 10), {
      selectedPrefix: (t: string) => this.theme.fg("accent", t),
      selectedText: (t: string) => this.theme.fg("accent", t),
      description: (t: string) => this.theme.fg("muted", t),
      scrollInfo: (t: string) => this.theme.fg("dim", t),
      noMatch: (t: string) => this.theme.fg("warning", t),
    });

    this.selectList.onSelect = (item) => {
      const result = this.results.find(r => r.displayName === item.value) || null;
      if (result && result.detailsStatus !== "done") {
        return; // explicitly block opening if not done
      }
      
      this.selectedResult = result;
      if (this.selectedResult) {
        // User requested commits to be the default view always.
        this.activeTab = "commits";
        this.triggerLazyChangelogFileCheck(this.selectedResult);
      }
      this.updateFormattedLines();
      this.mode = "details";
      this.scrollOffset = 0;
      this.rebuild();
      this.tui.requestRender();
    };

    this.selectList.onCancel = () => {
      this.close();
    };
  }

  private updateSelectListSpinners() {
    if (!this.selectListItems) return;
    let mutated = false;

    let maxVerLength = 0;
    for (const r of this.results) {
      const verPart = r.currentVersion !== "installed" ? `v${r.currentVersion} → v${r.latestVersion}` : "Updates available";
      if (verPart.length > maxVerLength) {
        maxVerLength = verPart.length;
      }
    }
    const targetVerWidth = Math.max(18, maxVerLength);

    for (const item of this.selectListItems) {
      const r = this.results.find(res => res.displayName === item.value);
      if (!r) continue;
      
      let baseLabel = r.displayName;
      const verPart = r.currentVersion !== "installed" ? `v${r.currentVersion} → v${r.latestVersion}` : "Updates available";
      let baseDesc = verPart.padEnd(targetVerWidth);
      const relTime = formatRelativeTime(r.latestDate);
      if (relTime) {
        baseDesc += `  ${relTime}`;
      }

      if (this.isConfirmingUpdate && r.displayName === this.confirmingPackage?.displayName) {
        const newLabel = baseLabel;
        const newDesc = `Young package (< 3d), update? [y/n]`;
        if (item.label !== newLabel || item.description !== newDesc) {
          item.label = newLabel;
          item.description = newDesc;
          mutated = true;
        }
      } else if (r.updateStatus === "updating") {
        const spinner = this.spinnerFrames[this.spinnerIdx];
        const newLabel = `${spinner} ${baseLabel}`;
        const newDesc = `Updating...`;
        if (item.label !== newLabel || item.description !== newDesc) {
          item.label = newLabel;
          item.description = newDesc;
          mutated = true;
        }
      } else if (r.installedSuccess) {
        const newLabel = `✓ ${baseLabel}`;
        const newDesc = `installed!`;
        if (item.label !== newLabel || item.description !== newDesc) {
          item.label = newLabel;
          item.description = newDesc;
          mutated = true;
        }
      } else if (r.updateStatus === "queued") {
        const newLabel = `⏳ ${baseLabel}`;
        const newDesc = `Queued for update`;
        if (item.label !== newLabel || item.description !== newDesc) {
          item.label = newLabel;
          item.description = newDesc;
          mutated = true;
        }
      } else if (r.updateStatus === "error") {
        const newLabel = `✗ ${baseLabel}`;
        const newDesc = `Failed — press u to retry`;
        if (item.label !== newLabel || item.description !== newDesc) {
          item.label = newLabel;
          item.description = newDesc;
          mutated = true;
        }
      } else if (r.detailsStatus === "loading") {
        const newLabel = `${this.spinnerFrames[this.spinnerIdx]} ${baseLabel}`;
        if (item.label !== newLabel) {
          item.label = newLabel;
          item.description = "Fetching details...";
          mutated = true;
        }
      } else {
        if (item.label !== baseLabel || item.description !== baseDesc) {
          item.label = baseLabel;
          item.description = baseDesc;
          mutated = true; 
        }
      }
    }
    if (mutated && this.selectList) {
      this.selectList.invalidate();
    }
  }

  private updateFormattedLines() {
    if (!this.selectedResult) return;
    let content = "";
    if (this.activeTab === "commits") {
      content = this.selectedResult.commits || "No commits available.";
    } else if (this.activeTab === "releases") {
      content = this.selectedResult.changelog || "No release notes available.";
    } else if (this.activeTab === "changelog") {
      content = this.selectedResult.changelogFileContent || "No CHANGELOG file found in repository.";
    }
    
    this.formattedLines = formatChangelog(content, this.theme, this.showDates);
    this.cachedInnerWidth = 0; // force re-wrap on next render
  }

  private rebuild() {
    this.updateOverlayWidth();
    this.container.clear();
    
    if (this.mode === "loading") {
      // Handled directly in render() to strictly enforce dimensions and centering
    } else if (this.mode === "list") {
      if (this.results.length === 0) {
        this.container.addChild(new Spacer(1));
        this.container.addChild(new Text(this.theme.fg("success", "  ✓ All packages are up to date!"), 0, 0));
        this.container.addChild(new Spacer(1));
        this.container.addChild(new Text(this.theme.fg("dim", "  esc close"), 0, 0));
      } else {
        this.container.addChild(new Text(this.theme.bold("📦 Select a package to view changelog"), 0, 0));
        this.container.addChild(new Spacer(1));
        
        // Re-assign the list items if some statuses changed? The SelectList doesn't support mutation easily.
        // So we render a separate status line below it for background activity.
        this.container.addChild(this.selectList);
        this.container.addChild(new Spacer(1));
        
        const key = (k: string) => this.theme.fg("muted", k);
        const action = (a: string) => this.theme.fg("dim", a);
        const sep = this.theme.fg("dim", " • ");
        const bracketKey = (k: string, rest: string) => action("[") + key(k) + action("]" + rest);

        const navText = `${key("↑↓/jk")} ${action("navigate")}${sep}${key("enter")} ${action("view")}${sep}${bracketKey("u", "pdate/queue")}${sep}${key("esc")} ${action("close")}`;
        this.container.addChild(new Text(navText, 0, 0));
      }
    }
  }

  private close() {
    if (this.disposed) return;
    this.disposed = true;
    this.updateQueue = [];
    clearInterval(this.timer);
    for (const timer of this.removalTimers.values()) {
      clearTimeout(timer);
    }
    this.removalTimers.clear();
    this.done();
  }

  handleInput(data: string) {
    if (this.isConfirmingUpdate) {
      if (matchesKey(data, "y") || data === "Y") {
        const pkg = this.confirmingPackage;
        this.isConfirmingUpdate = false;
        this.confirmingPackage = null;
        if (pkg) {
          this.queueOrStartUpdate(pkg);
        }
      } else if (matchesKey(data, "n") || data === "N" || matchesKey(data, Key.escape)) {
        this.isConfirmingUpdate = false;
        this.confirmingPackage = null;
        if (this.mode === "list") {
          this.updateSelectListSpinners();
        } else {
          this.rebuild();
        }
        this.tui.requestRender();
      }
      return;
    }

    if (this.mode === "loading") {
      if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
        this.close();
      }
      return;
    }

    if (matchesKey(data, "u")) {
      if (this.mode === "list" && this.selectList) {
        const selectedValue = this.selectList.getSelectedItem()?.value;
        const selectedUpdate = this.results.find(r => r.displayName === selectedValue);
        if (selectedUpdate && selectedUpdate.detailsStatus === "done") {
          this.tryPerformUpdate(selectedUpdate);
        }
      } else if (this.mode === "details" && this.selectedResult && this.selectedResult.detailsStatus === "done") {
        this.tryPerformUpdate(this.selectedResult);
      }
      return;
    }

    if (matchesKey(data, "d")) {
      if (this.mode === "details" && this.activeTab !== "commits") {
        return;
      }
      this.showDates = !this.showDates;
      if (this.mode === "details") this.updateFormattedLines();
      this.rebuild();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "v") && this.mode === "details" && this.selectedResult?.detailsStatus === "done") {
      const hasChangelogFile = this.selectedResult.changelogFileStatus === "found";
      if (this.activeTab === "commits") {
        this.activeTab = "releases";
      } else if (this.activeTab === "releases") {
        if (hasChangelogFile) {
          this.activeTab = "changelog";
        } else {
          this.activeTab = "commits";
        }
      } else {
        this.activeTab = "commits";
      }
      this.updateFormattedLines();
      this.scrollOffset = 0;
      this.rebuild();
      this.tui.requestRender();
      return;
    }

    if (this.mode === "list") {
      if (this.results.length === 0) {
        if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.enter)) {
          this.close();
        }
        return;
      }
      // Add vim key support for the SelectList
      if (matchesKey(data, "j")) {
        this.selectList.handleInput("\x1b[B"); // Send ANSI down arrow
      } else if (matchesKey(data, "k")) {
        this.selectList.handleInput("\x1b[A"); // Send ANSI up arrow
      } else {
        this.selectList.handleInput(data);
      }
    } else {
      const maxScroll = Math.max(0, this.cachedWrappedLines.length - this.maxDetailLines);
      
      // gg / G support
      if (data === "g") {
        if (this.lastKey === "g") {
          this.scrollOffset = 0;
          this.lastKey = "";
          this.tui.requestRender();
          return;
        } else {
          this.lastKey = "g";
          return; // wait for next key
        }
      } else if (data === "G") {
        this.scrollOffset = maxScroll;
        this.lastKey = "";
        this.tui.requestRender();
        return;
      }
      this.lastKey = "";

      if (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace) || matchesKey(data, "q") || matchesKey(data, Key.left)) {
        this.mode = "list";
        this.rebuild();
      } else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
        const jump = matchesKey(data, Key.ctrl("u")) ? Math.max(1, Math.floor(this.maxDetailLines / 2)) : this.maxDetailLines;
        this.scrollOffset = Math.max(0, this.scrollOffset - jump);
      } else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
        const jump = matchesKey(data, Key.ctrl("d")) ? Math.max(1, Math.floor(this.maxDetailLines / 2)) : this.maxDetailLines;
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + jump);
      }
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.updateOverlayWidth();
    const innerWidth = width - 4;
    let contentLines: string[] = [];

    if (this.mode === "loading") {
      const text = "📦 Checking for package updates";
      const plainTextLength = 31;
      const padLeft = Math.max(0, Math.floor((innerWidth - plainTextLength) / 2));
      const centeredText = " ".repeat(padLeft) + this.theme.bold(text);
      contentLines = [
        "",
        centeredText,
        ""
      ];
    } else if (this.mode === "details" && this.selectedResult) {
      // Create header
      const headerText = `📦 ${this.selectedResult.displayName} (v${this.selectedResult.currentVersion} → v${this.selectedResult.latestVersion})`;
      contentLines.push(this.theme.bold(headerText));
      contentLines.push("");
      
      if (this.selectedResult.installedSuccess) {
         const text = `✓ ${this.selectedResult.displayName} successfully installed!`;
         const padLeft = Math.max(0, Math.floor((innerWidth - text.length) / 2));
         contentLines.push(" ".repeat(padLeft) + this.theme.fg("success", this.theme.bold(text)));
         while (contentLines.length < 2 + this.maxDetailLines) contentLines.push("");
         contentLines.push("");
         contentLines.push(this.theme.fg("dim", "returning to list..."));
      } else if (this.selectedResult.detailsStatus === "loading") {
         const spinner = this.spinnerFrames[this.spinnerIdx];
         contentLines.push(this.theme.fg("accent", `  ${spinner} Fetching details...`));
         while (contentLines.length < 2 + this.maxDetailLines) contentLines.push("");
         contentLines.push("");
         contentLines.push(this.theme.fg("dim", `esc/left back`));
      } else if (this.isConfirmingUpdate) {
         contentLines.push("");
         contentLines.push(this.theme.fg("warning", `  ⚠️ This package was released younger than 3 days ago.`));
         contentLines.push("");
         contentLines.push(this.theme.fg("warning", `  Do you want to proceed with the update? [y/n]`));
         while (contentLines.length < 2 + this.maxDetailLines) contentLines.push("");
         contentLines.push("");
         contentLines.push(this.theme.fg("dim", `  [y]es / [n]o or esc`));
      } else {
        if (innerWidth !== this.cachedInnerWidth) {
          this.cachedWrappedLines = this.formattedLines.flatMap(line => {
            if (line === "## __COMMIT_HISTORY_SEPARATOR__") {
              const label = "-- new changes above this line ";
              const hyphens = "-".repeat(Math.max(0, innerWidth - label.length));
              return [this.theme.fg("warning", label + hyphens)];
            }
            return wrapTextWithAnsi(line, innerWidth);
          });
          this.cachedInnerWidth = innerWidth;
        }
        
        const maxScroll = Math.max(0, this.cachedWrappedLines.length - this.maxDetailLines);
        this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
        
        const visibleLines = this.cachedWrappedLines.slice(this.scrollOffset, this.scrollOffset + this.maxDetailLines);
        contentLines.push(...visibleLines);
        
        while (contentLines.length < 2 + this.maxDetailLines) {
          contentLines.push("");
        }
        
        contentLines.push("");
        const showingEnd = Math.min(this.scrollOffset + this.maxDetailLines, this.cachedWrappedLines.length);
        const scrollInfo = this.theme.fg("dim", `Lines ${this.scrollOffset + 1}-${showingEnd} of ${Math.max(1, this.cachedWrappedLines.length)}`);
        
        const key = (k: string) => this.theme.fg("muted", k);
        const action = (a: string) => this.theme.fg("dim", a);
        const sep = this.theme.fg("dim", " • ");
        const bracketKey = (k: string, rest: string) => action("[") + key(k) + action("]" + rest);

        let tabsList: string[] = ["commits", "releases"];
        if (this.selectedResult.changelogFileStatus === "found") {
          tabsList.push("changelog");
        } else if (this.selectedResult.changelogFileStatus === "checking") {
          const spinner = this.spinnerFrames[this.spinnerIdx];
          tabsList.push(`${spinner}changelog`);
        }

        const formattedTabs = tabsList.map(t => {
          const isCurrent = t === this.activeTab || (t.endsWith("changelog") && this.activeTab === "changelog");
          if (isCurrent) {
            return this.theme.fg("accent", this.theme.bold(t));
          } else {
            return this.theme.fg("dim", t);
          }
        }).join(this.theme.fg("dim", "|"));

        let controls = `${key("↑↓/jk")} ${action("scroll")}${sep}${key("esc/left")} ${action("back")}${sep}${bracketKey("v", "iew")}: ${formattedTabs}`;
        if (this.activeTab === "commits") {
          controls += `${sep}${bracketKey("d", "ates: " + (this.showDates ? "on" : "off"))}`;
        }
        contentLines.push(`${scrollInfo}${sep}${controls}`);
      }
    } else {
      contentLines = this.container.render(innerWidth);
    }
    
    const top = this.theme.fg("accent", "╭" + "─".repeat(innerWidth + 2) + "╮");
    const bottom = this.theme.fg("accent", "╰" + "─".repeat(innerWidth + 2) + "╯");
    
    const borderedLines = contentLines.map((line) => {
      const paddedLine = truncateToWidth(line, innerWidth, "", true);
      return this.theme.fg("accent", "│ ") + paddedLine + this.theme.fg("accent", " │");
    });
    
    return [top, ...borderedLines, bottom];
  }

  invalidate() {
    this.container.invalidate();
    this.rebuild();
  }
}

export default function (pi: ExtensionAPI) {
  let lastCheckTime = 0;
  let cachedUpdates: PackageUpdate[] = [];

  async function checkUpdates(pi: ExtensionAPI): Promise<PackageUpdate[]> {
    const agentDir = getAgentDir();
    const settingsPath = join(agentDir, "settings.json");
    let packages: any[] = [];
    try {
      packages = JSON.parse(await readFile(settingsPath, "utf-8")).packages ?? [];
    } catch { return []; }

    const seen = new Set<string>();
    const checks = packages.map(async (pkg): Promise<PackageUpdate | null> => {
      const source = typeof pkg === "string" ? pkg : pkg.source;
      if (!source || seen.has(source)) return null;
      seen.add(source);

      if (source.startsWith("/") || source.startsWith(".") || source.startsWith("file:")) return null;
      if (source.match(/@\d+\.\d+\.\d+$/)) return null;

      const npmParsed = parseNpmSource(source);
      if (npmParsed) {
        const installedVersion = await getInstalledVersion(npmParsed.name, agentDir);
        if (!installedVersion) return null;
        const latestInfo = await getLatestNpmInfo(npmParsed.name);
        if (!latestInfo || !latestInfo.version || !isNewerVersion(latestInfo.version, installedVersion)) return null;
        
        return {
          displayName: npmParsed.name,
          currentVersion: installedVersion,
          latestVersion: latestInfo.version,
          source,
          type: "npm",
          detailsStatus: "idle",
          latestDate: latestInfo.publishDate
        };
      }

      const gitParsed = parseGitSource(source);
      if (gitParsed) {
        const installPath = join(agentDir, "git", gitParsed.host, gitParsed.path);
        if (!existsSync(installPath)) return null;
        
        try {
          await pi.exec("git", ["fetch", "--quiet"], { cwd: installPath, timeout: 15000 });
          const res = await pi.exec("git", ["log", "HEAD..FETCH_HEAD", "--oneline"], { cwd: installPath, timeout: 5000 });
          if (res.code === 0 && res.stdout.trim() !== "") {
            const dateRes = await pi.exec("git", ["log", "-1", "FETCH_HEAD", "--format=%cd", "--date=short"], { cwd: installPath, timeout: 5000 });
            const latestDate = dateRes.code === 0 ? dateRes.stdout.trim() : null;

            return {
              displayName: `${gitParsed.host}/${gitParsed.path}`,
              currentVersion: "installed",
              latestVersion: "remote",
              source,
              type: "git",
              installPath,
              detailsStatus: "idle",
              latestDate
            };
          }
        } catch {}
      }
      return null;
    });

    const results = await Promise.all(checks);
    return results.filter(r => r !== null) as PackageUpdate[];
  }

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    if (process.env.PI_OFFLINE) return;
    if (!ctx.hasUI) return;

    const now = Date.now();
    if (now - lastCheckTime < UPDATE_CHECK_INTERVAL_MS) return;
    lastCheckTime = now;

    checkUpdates(pi).then((results) => {
      cachedUpdates = results;
      if (results.length === 0) return;
      const count = results.length;
      const line = `📦 ${count} extension${count > 1 ? 's have' : ' has'} updates — run /update-changelog for details`;
      ctx.ui.notify(line, "info");
    }).catch(() => {});
  });

  pi.registerCommand("update-changelog", {
    description: "Show interactive changelogs for packages with available updates",
    handler: async (_args, ctx) => {
      let resultsPromise: Promise<PackageUpdate[]>;

      if (cachedUpdates.length > 0) {
        resultsPromise = Promise.resolve(cachedUpdates);
      } else {
        resultsPromise = checkUpdates(pi).then(res => {
          cachedUpdates = res;
          return res;
        });
      }

      const overlayOptions: any = { width: "100%", maxHeight: "90%", anchor: "center" };
      await ctx.ui.custom((tui, theme, kb, done) => {
        const explorer = new UpdateExplorer(
          resultsPromise, 
          pi, 
          theme, 
          tui, 
          done,
          (displayName) => {
            cachedUpdates = cachedUpdates.filter(r => r.displayName !== displayName);
          }
        );
        explorer.setOverlayOptions(overlayOptions);
        return explorer;
      }, { 
        overlay: true, 
        overlayOptions
      });

      // No need to clear widget on exit since we no longer use one for the notification
    },
  });

  pi.registerTool({
    name: "package_changelog",
    label: "Package Changelog",
    description: "Fetch changelog and release notes for an npm package or GitHub repository. Shows version history and recent changes.",
    promptSnippet: "Check package changelog or release notes",
    promptGuidelines: ["Use package_changelog when the user asks what changed in a pi extension package or npm package."],
    parameters: Type.Object({
      package: Type.String({ description: "npm package name (e.g. 'pi-ask-user') or GitHub repo path (e.g. 'user/repo')" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { package: packageName } = params;

      if (packageName.includes("/")) {
        const releases = await fetchGitHubReleases(packageName);
        if (releases) {
          return {
            content: [{ type: "text", text: `## ${packageName} — Recent Releases\n\n${releases}` }],
            details: { type: "github", owner: packageName.split("/")[0], repo: packageName.split("/")[1] },
          };
        }
        return {
          content: [{ type: "text", text: `No releases found for ${packageName}` }],
          details: { type: "github", owner: packageName.split("/")[0], repo: packageName.split("/")[1] },
        };
      }

      const agentDir = getAgentDir();
      const latestInfo = await getLatestNpmInfo(packageName);
      const latestVersion = latestInfo?.version ?? "unknown";
      const installedVersion = await getInstalledVersion(packageName, agentDir);

      const { changelog, repoUrl } = await fetchNpmChangelog(
        packageName,
        latestVersion !== "unknown" ? latestVersion : "latest"
      );

      let text = `## ${packageName}\n`;
      text += `Installed: ${installedVersion ?? "not installed"} | Latest: ${latestVersion}\n`;
      if (repoUrl) text += `Repository: ${repoUrl}\n\n`;

      if (changelog) {
        text += changelog.slice(0, 3000);
      } else {
        text += "No changelog available. ";
        if (repoUrl) text += `Check the repository: ${repoUrl}`;
        else text += "Try searching npm or GitHub directly.";
      }

      return {
        content: [{ type: "text", text }],
        details: { type: "npm", name: packageName, installed: installedVersion, latest: latestVersion },
      };
    },
  });
}