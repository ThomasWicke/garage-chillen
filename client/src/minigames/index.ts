// Bootstrap: importing this module triggers each mini-game client's
// self-registration. Add new mini-games here.

import "./pong";
import "./asteroids";
import "./flappy-bird";
import "./snake-duel";
import "./light-cycles";
import "./tron-arena";
import "./sumo-push";
import "./air-hockey";
import "./reaction-duel";
import "./whack-a-mole";
import "./color-tap";
import "./hot-potato";
import "./memory-sequence";

export { getMiniGameClient } from "./registry";
