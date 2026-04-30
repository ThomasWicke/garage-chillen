// Bootstrap: importing this module triggers each gamemode client's
// self-registration. Add new gamemodes here.

import "./tournament";
import "./last-man-standing";

export { getGamemodeClient } from "./registry";
