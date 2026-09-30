#!/usr/bin/env node
// The PR watch runner lives in kit-pr-watch/pr-watch.mjs. This forwarder keeps a LaunchAgent installed
// from the old path working; `install` run through it writes the kit's path, so remove it once the
// LaunchAgent has been reinstalled.
import '../../kit-pr-watch/pr-watch.mjs';
