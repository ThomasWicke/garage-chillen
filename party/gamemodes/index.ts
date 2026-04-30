// Bootstrap: importing this module triggers each gamemode's self-registration.
// Add new gamemodes here.

import "./tournament";
import "./last-man-standing";

export { allGamemodes, getGamemode } from "./registry";
