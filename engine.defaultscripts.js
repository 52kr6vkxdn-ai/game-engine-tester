/* ============================================================
   Zengine — engine.defaultscripts.js
   Ships a library of ready-to-use game scripts.
   Called once when the engine first starts (or on new project).
   Users can attach these scripts to any sprite and start playing.

   Included scripts:
     1. PlatformerPlayer   — WASD/arrows + jump, with kinematic body
     2. TopDownPlayer      — 8-directional movement + aim at mouse
     3. PatrolEnemy        — back-and-forth patrol, sends messages
     4. HealthSystem       — HP bar, onMessage("takeDamage")
     5. CameraFollow       — makes the scene camera track this object
     6. Rotator             — simple constant rotation (great for coins)
     7. Destroyer           — destroys self after a timer (bullets, FX)
     8. Oscillator          — smooth sine-wave bobbing motion
   ============================================================ */

export const DEFAULT_SCRIPTS = [

/* ── 1. Platformer Player ───────────────────────────────────── */
{
    name: 'PlatformerPlayer',
    code: `// ============================================================
// PLATFORMER PLAYER
// Requires: Kinematic physics body on this object
//           A tilemap or static objects below to stand on
//
// Controls:
//   A / D or Arrow Left/Right  — move
//   W / Space or Arrow Up      — jump
// ============================================================

// ── Tuning knobs ─────────────────────────────────────────────
const SPEED      = 5;     // horizontal move speed (world units/sec)
const JUMP_FORCE = 8;     // jump velocity (world units/sec)
const GRAVITY    = 20;    // manual gravity applied each frame
const MAX_FALL   = 20;    // terminal falling speed

// ── Internal state ────────────────────────────────────────────
var isGrounded  = false;
var groundTimer = 0;     // small grace period so you can still jump just after leaving a ledge
var facing      = 1;     // 1 = right, -1 = left

onStart(() => {
  setTag("player");
  log("Platformer Player ready!");
  log("A/D or arrows = move  |  W/Space = jump");
});

onUpdate((dt) => {

  // ── Horizontal input ───────────────────────────────────────
  const h = axisH();
  if (h !== 0) facing = h;
  setScaleX(facing);   // flip sprite to face direction

  // Move horizontally by overriding velocity X directly
  velocityX = h * SPEED;

  // ── Gravity (manual — works without a physics body too) ────
  velocityY -= GRAVITY * dt;
  velocityY  = clamp(velocityY, -MAX_FALL, MAX_FALL);

  // ── Jump ───────────────────────────────────────────────────
  groundTimer = max(0, groundTimer - dt);
  if (isKeyJustDown("w") || isKeyJustDown("arrowup") || isKeyJustDown(" ")) {
    if (isGrounded || groundTimer > 0) {
      velocityY  = JUMP_FORCE;
      isGrounded = false;
      groundTimer = 0;
    }
  }

  // ── Animation ─────────────────────────────────────────────
  if (!isGrounded) {
    playAnimation(velocityY > 0 ? "jump" : "fall");
  } else if (abs(h) > 0.1) {
    playAnimation("run");
  } else {
    playAnimation("idle");
  }

});

onCollision((other) => {
  // A collision with anything below us means we're grounded.
  // We detect "below" by checking if our Y is above the other object.
  if (!other) return;
  if (getY() > other.y - 0.5) {
    isGrounded  = true;
    groundTimer = 0.15;   // coyote time
    if (velocityY < 0) velocityY = 0;   // stop falling
  }
});

onStop(() => {
  velocityX = 0;
  velocityY = 0;
});
`,
},

/* ── 2. Top-Down Player ─────────────────────────────────────── */
{
    name: 'TopDownPlayer',
    code: `// ============================================================
// TOP-DOWN PLAYER
// 8-directional movement + optional mouse aim
//
// Controls:
//   W A S D or Arrow Keys  — move
//   Mouse                  — aim / face direction
// ============================================================

const SPEED = 5;   // world units per second

onStart(() => {
  setTag("player");
  log("Top-Down Player ready!");
  log("WASD or arrows = move  |  Mouse = aim");
});

onUpdate((dt) => {

  // ── Movement ───────────────────────────────────────────────
  const h = axisH();
  const v = axisV();

  move(h * SPEED * dt, v * SPEED * dt);

  // ── Normalise diagonal so you don't move faster diagonally ─
  // (already handled by individual move() calls with dt)

  // ── Face the mouse ─────────────────────────────────────────
  // input.mouseX/Y are in screen pixels; divide by 100 to get world units
  lookAt(input.mouseX / 100, -input.mouseY / 100);

  // ── Animation ─────────────────────────────────────────────
  const moving = abs(h) > 0.1 || abs(v) > 0.1;
  playAnimation(moving ? "walk" : "idle");

});

onStop(() => {
  // nothing to clean up
});
`,
},

/* ── 3. Patrol Enemy ────────────────────────────────────────── */
{
    name: 'PatrolEnemy',
    code: `// ============================================================
// PATROL ENEMY
// Walks back and forth between two patrol points.
// Broadcasts a "playerDetected" message when the player
// gets close, and listens for "takeDamage".
//
// Setup:
//   Give this object a kinematic or dynamic physics body.
//   Adjust PATROL_DIST and DETECT_RANGE below.
// ============================================================

const SPEED       = 2.5;  // patrol speed (world units/sec)
const PATROL_DIST = 4;    // how far to walk each direction (world units)
const DETECT_RANGE= 3;    // distance at which the player is spotted
const MAX_HP      = 3;    // hit points

var startX   = 0;
var dirX     = 1;   // 1 = right, -1 = left
var hp       = MAX_HP;
var alerted  = false;

onStart(() => {
  setTag("enemy");
  startX = getX();
  log("Patrol Enemy ready (HP: " + MAX_HP + ")");
});

onUpdate((dt) => {
  if (hp <= 0) return;

  // ── Patrol movement ────────────────────────────────────────
  translate(dirX * SPEED * dt, 0);
  setScaleX(dirX);   // flip to face direction

  // Reverse direction at patrol bounds
  if (getX() > startX + PATROL_DIST) { dirX = -1; }
  if (getX() < startX - PATROL_DIST) { dirX =  1; }

  // ── Player detection ───────────────────────────────────────
  const player = findWithTag("player");
  if (player) {
    const d = dist(getX(), getY(), player.x, player.y);
    if (d < DETECT_RANGE && !alerted) {
      alerted = true;
      broadcast("player", "enemySpotted");   // tell player they were spotted
      log("Player detected!");
    }
    if (d >= DETECT_RANGE + 1) alerted = false;   // lost sight
  }
});

// ── Receive damage ─────────────────────────────────────────
onMessage("takeDamage", (amount) => {
  hp -= (amount || 1);
  warn("Enemy hit! HP remaining: " + hp);
  if (hp <= 0) {
    log("Enemy defeated!");
    hide();           // hide the sprite
    destroySelf();    // remove from scene
  }
});

onCollision((other) => {
  if (!other) return;
  // If we hit a wall (no name match) reverse direction
  if (other.name !== "player") dirX *= -1;
});

onStop(() => {
  hp = MAX_HP;
  alerted = false;
});
`,
},

/* ── 4. Health System ───────────────────────────────────────── */
{
    name: 'HealthSystem',
    code: `// ============================================================
// HEALTH SYSTEM
// Attach to any object to give it health.
// Listens for "takeDamage" and "heal" messages.
// Broadcasts "died" when HP reaches 0.
//
// Example: from another script — sendMessage("player", "takeDamage", 1)
// ============================================================

const MAX_HP = 10;

var hp          = MAX_HP;
var invincible  = false;   // brief invincibility after being hit
var iTimer      = 0;
const I_TIME    = 1.0;     // invincibility duration in seconds

onStart(() => {
  hp = MAX_HP;
  log(getName() + " HP: " + hp + " / " + MAX_HP);
});

function getName() { return find(getTag()) ? getTag() : "Object"; }

onUpdate((dt) => {
  if (invincible) {
    iTimer -= dt;
    // Flash the sprite while invincible
    setAlpha(iTimer % 0.2 < 0.1 ? 0.3 : 1.0);
    if (iTimer <= 0) { invincible = false; setAlpha(1); }
  }
});

onMessage("takeDamage", (amount) => {
  if (invincible) return;
  hp -= (amount || 1);
  log("Took " + amount + " damage — HP: " + hp + "/" + MAX_HP);
  invincible = true;
  iTimer = I_TIME;
  if (hp <= 0) {
    hp = 0;
    log("Died!");
    broadcastAll("died");
    hide();
    destroySelf();
  }
});

onMessage("heal", (amount) => {
  hp = clamp(hp + (amount || 1), 0, MAX_HP);
  log("Healed to " + hp + "/" + MAX_HP);
  setAlpha(1);
});

onMessage("getHP", () => {
  return hp;
});

onStop(() => {
  hp = MAX_HP;
  invincible = false;
  setAlpha(1);
});
`,
},

/* ── 5. Camera Follow ───────────────────────────────────────── */
{
    name: 'CameraFollow',
    code: `// ============================================================
// CAMERA FOLLOW
// Attaches to any object and makes the viewport follow it.
// Uses the engine's sceneContainer to pan the camera.
// ============================================================

const SMOOTH  = 6;    // higher = snappier camera (0 = instant)
const OFFSET_X= 0;    // horizontal offset from the target (world units)
const OFFSET_Y= 1;    // vertical offset (positive = above target)

// Camera dead-zone: camera only moves if target is outside this box
const DEAD_X  = 1;
const DEAD_Y  = 0.5;

onStart(() => {
  log("CameraFollow active — tracking " + find("player")?.name);
});

onUpdate((dt) => {
  // Target: follow the first object tagged "player"
  // You can change "player" to any label or tag.
  const target = findWithTag("player") || find("player");
  if (!target) return;

  // World centre of the viewport (scene container pivot)
  // The engine stores the camera offset in state.sceneContainer
  // which we can nudge via translate on a dedicated camera object.
  // Simpler: just move this (invisible) object and use its position
  // to offset scene objects or rely on PixiJS camera tracking.

  // Move this object smoothly toward the target
  const tx = target.x + OFFSET_X;
  const ty = target.y + OFFSET_Y;
  const dx = tx - getX();
  const dy = ty - getY();

  // Dead zone
  if (abs(dx) < DEAD_X && abs(dy) < DEAD_Y) return;

  const t = clamp(SMOOTH * dt, 0, 1);
  translate(dx * t, dy * t);
});
`,
},

/* ── 6. Rotator ─────────────────────────────────────────────── */
{
    name: 'Rotator',
    code: `// ============================================================
// ROTATOR
// Constantly rotates this object. Great for coins, power-ups,
// spinning saw blades, loading spinners, etc.
// ============================================================

const SPEED = 180;   // degrees per second (positive = clockwise)

onUpdate((dt) => {
  setRotation(getRotation() + SPEED * dt);
});
`,
},

/* ── 7. Destroyer ───────────────────────────────────────────── */
{
    name: 'Destroyer',
    code: `// ============================================================
// DESTROYER
// Destroys this object after a set time.
// Perfect for bullets, explosion effects, pickup flash FX.
// ============================================================

const LIFETIME = 3.0;   // seconds until this object disappears

var elapsed = 0;
var fadeStart = 0.5;    // start fading out this many seconds before death

onStart(() => {
  elapsed = 0;
});

onUpdate((dt) => {
  elapsed += dt;

  // Fade out near the end of lifetime
  if (elapsed > LIFETIME - fadeStart) {
    const remaining = LIFETIME - elapsed;
    setAlpha(clamp(remaining / fadeStart, 0, 1));
  }

  if (elapsed >= LIFETIME) {
    destroySelf();
  }
});
`,
},

/* ── 8. Oscillator ──────────────────────────────────────────── */
{
    name: 'Oscillator',
    code: `// ============================================================
// OSCILLATOR
// Makes this object bob up and down (or side to side) smoothly
// using a sine wave. Perfect for floating platforms, coins,
// decorative elements.
// ============================================================

const AMPLITUDE = 0.5;   // how far to move (world units)
const FREQUENCY = 1.0;   // oscillations per second
const AXIS      = "y";   // "y" = up/down, "x" = left/right

var originX = 0;
var originY = 0;

onStart(() => {
  originX = getX();
  originY = getY();
});

onUpdate((dt) => {
  const offset = sin(getTime() * frequency * PI * 2) * AMPLITUDE;
  if (AXIS === "y") {
    setY(originY + offset);
  } else {
    setX(originX + offset);
  }
});

var frequency = FREQUENCY;
`,
},

];

// ── Inject default scripts into a fresh project ────────────────
export function injectDefaultScripts(scriptStore) {
    for (const ds of DEFAULT_SCRIPTS) {
        // Only add if not already present (don't overwrite user edits)
        if (!scriptStore.find(s => s.name === ds.name)) {
            scriptStore.push({
                id:        'default_' + ds.name,
                name:      ds.name,
                code:      ds.code,
                updatedAt: Date.now(),
                isDefault: true,
            });
        }
    }
}
