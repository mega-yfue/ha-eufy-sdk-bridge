// Preload form of log-time.mjs (`node --import ./src/log-time-install.mjs`), for a launcher that cannot
// change server.mjs. server.mjs installs the same prefix itself when LOG_TIMESTAMPS is set.
import { installConsoleTimestamps } from "./log-time.mjs";

installConsoleTimestamps();
