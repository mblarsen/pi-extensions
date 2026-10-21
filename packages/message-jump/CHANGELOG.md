# @mblarsen/pi-message-jump

## 0.1.0

### Minor Changes

- 7ba6126: Add transcript jumps for every message: `ctrl+shift+k` for the previous one and
  `ctrl+shift+j` for the next, plus `/jump prev` and `/jump next` for terminals
  that intercept those keys.
  
  `/jump` is the one command. It carries `prev`, `next`, `context` and `debug` as
  subcommands, and completes them after a space, so `/jump c` reaches `context`
  and `/jump context ` lists the common settings.
  
  Jumps land on the first line of message text rather than on the top of the
  message, so thinking blocks above the text stay out of the way. Turns that only
  thought or only called tools are not stops, and prompts are, which keeps the
  jumps moving in a session where most assistant turns carry no prose.
  
  A jump also leaves the previous message's tail on screen: the target's first
  line lands two thirds of the way down the viewport. `/jump context` changes that
  to any row count or fraction, including `0` for the old top-of-screen landing.
  Navigation measures from the message you jumped to rather than from the viewport
  top, so the next press moves on instead of nudging, a close message inside the
  context band is still reachable, and a jump that pi clamps at the end of the
  transcript keeps the same reference.
  
  `/jump debug` writes its report, and the last 20 jumps, to
  `/tmp/pi-message-jump-debug.json`.
