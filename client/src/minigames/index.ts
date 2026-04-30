// Bootstrap: importing this module triggers each mini-game client's
// self-registration. Add new mini-games here.

import "./pong";
import "./asteroids";
import "./flappy-bird";

export { getMiniGameClient } from "./registry";
