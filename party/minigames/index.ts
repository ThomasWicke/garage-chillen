// Bootstrap: importing this module triggers each mini-game's self-registration.
// Add new mini-games here.

import "./pong";
import "./asteroids";
import "./flappy-bird";

export { allMiniGames, getMiniGame } from "./registry";
