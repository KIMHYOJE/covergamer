import type { Rules, Seat } from '../net/protocol'

/** A ball on the arena floor: position in metres, velocity in metres per second. */
export type Motion = { x: number; z: number; vx: number; vz: number }
/** A contact this client resolved: `seat` must receive the impulse `jx`, `jz` on its own ball. */
export type Contact = { seat: Seat; jx: number; jz: number; closing: number }

/** Longest step the own ball takes at once, so a resumed tab does not jump. */
const MAX_STEP = 0.05
/**
 * One contact per pair of balls in this window, in seconds. When both owners detect the same
 * contact, each applies only its own half and ignores the hit the other sends, so the window must
 * exceed the client-to-client round trip. This is the shortest window; `setPeerDelay()` widens it
 * for each pair to twice the measured one-way delay between the two clients.
 */
export const HIT_WINDOW = 0.25

/**
 * Skills of the own ball. Cooldowns, in seconds, stay above the server's (1.5, 4, 4) so a real use
 * is never dropped. A dash adds speed and lifts the speed cap for `duration`; a guard softens every
 * impulse the ball receives; a blast pushes the balls within `radius` of the ball, each client applying
 * it to its own ball.
 */
export const SKILLS = {
  // `ram`: a dashing ball hits this much harder and loses less speed itself (`recoil`).
  dash: { cooldown: 2.5, duration: 0.45, kick: 12, capScale: 1.8, ram: 1.5, recoil: 0.55, minPush: 9 },
  guard: { cooldown: 6, duration: 1.3, soften: 0.55 },
} as const

/**
 * Blast: hold the button to charge, release to fire. A longer charge makes a wider, harder and slower-
 * to-recharge blast (`radius`, `power`, `cooldown` run from the first to the second number). While
 * charging the ball accelerates at `slow` of normal; a hit or blast that lands on it breaks the charge
 * (unless it guards), and a guard cannot hold against a charge at `pierce` or more.
 */
export const BLAST = {
  chargeTime: 1.3, minCharge: 0.15, autoRelease: 2, slow: 0.5, firstCooldown: 3, recoil: 3.5,
  radius: [4, 8.5], power: [10, 24], cooldown: [4.5, 9],
  pierce: 0.9, interruptImpulse: 4, interruptCooldown: 1.5,
} as const

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
const lerp = (range: readonly [number, number], t: number): number => range[0] + (range[1] - range[0]) * t

/** Charge level 0..1 after holding for `seconds`; a quick tap is level 0. */
export function chargeLevel(seconds: number): number {
  return clamp01((seconds - BLAST.minCharge) / (BLAST.chargeTime - BLAST.minCharge))
}

/** The blast a charge level makes: how far it reaches, how hard it pushes and how long it recharges. */
export function blastStats(level: number): { radius: number; power: number; cooldown: number } {
  const t = clamp01(level)
  return { radius: lerp(BLAST.radius, t), power: lerp(BLAST.power, t), cooldown: lerp(BLAST.cooldown, t) }
}
/**
 * The arena floor shrinks while a round is live: after `delay` seconds the edge moves in by `rate`
 * metres per second down to `minRadius`. The ring-out line stays where the server put it. A ball on
 * the shrunk-away part is not out: it is pulled toward the centre with `pull` m/s², weaker than a
 * ball's own acceleration. Only a push over the real edge puts a ball out, never standing still.
 */
export const SHRINK = { delay: 8, rate: 0.2, minRadius: 5.5, pull: 9 } as const

/** Floor radius `seconds` after the round went live. */
export function floorRadius(arenaRadius: number, seconds: number): number {
  const shrunk = arenaRadius - Math.max(0, seconds - SHRINK.delay) * SHRINK.rate
  return Math.max(Math.min(SHRINK.minRadius, arenaRadius), shrunk)
}

/** Speed above the normal cap (after a bump or blast) fades at this rate per second. */
const OVERSPEED_DECAY = 2.6
/** No ball ever reports more than this multiple of `max_speed`; the server drops poses above twice it. */
const ABSOLUTE_SPEED = 1.9

/**
 * The player's own ball. This client owns its movement: it applies input, resolves contacts with
 * the balls it draws, and publishes the result as a `pose`. The server relays the pose and decides
 * ring-outs from it. Every client runs the same `integrate()` and `touch()` with the numbers in
 * `welcome.rules`, so all balls follow one set of rules.
 *
 * A contact is applied once per pair. The client that detects it first applies its own half of
 * the impulse and returns the other half as a `Contact`; the game sends it to the owner of the
 * other ball as a `hit`. That owner applies it with `receiveHit()`.
 */
export class OwnBall implements Motion {
  x = 0
  z = 0
  vx = 0
  vz = 0
  /**
   * Set when the ball crosses the edge. The ball then holds the pose where it crossed, so every pose
   * it publishes stays outside until the server confirms; `BallView` draws the fall.
   */
  out = false
  private rules: Rules = { arena_radius: 10, ball_radius: 0.8, accel: 13, damping: 0.55, max_speed: 9, restitution: 0.95, win_score: 3 }
  private inputX = 0
  private inputZ = 0
  /** Seconds left of a dash and of a guard, and until each skill is ready again. */
  dashLeft = 0
  guardLeft = 0
  readonly cooldown: Record<'dash' | 'guard' | 'blast', number> = { dash: 0, guard: 0, blast: 0 }
  /** Holding a blast: seconds held so far. */
  charging = false
  chargeTime = 0
  /** The full cooldown of the blast last fired (or interrupted), for the HUD. */
  blastTotal: number = BLAST.cooldown[0]
  private broken = false
  /** Seconds of simulated time; the clock for `HIT_WINDOW`. */
  private clock = 0
  /** When this client last resolved a contact with each seat, and when it last sent one. */
  private readonly resolved = new Map<Seat, number>()
  private readonly sent = new Map<Seat, number>()
  /** Contact window per seat, at least `HIT_WINDOW`. */
  private readonly windows = new Map<Seat, number>()

  configure(rules: Rules): void {
    this.rules = rules
  }

  /** Holds the ball still at `x`, `z` (spawn before each round). */
  place(x: number, z: number): void {
    Object.assign(this, { x, z, vx: 0, vz: 0, out: false, dashLeft: 0, guardLeft: 0, charging: false, chargeTime: 0, broken: false, blastTotal: BLAST.firstCooldown })
    Object.assign(this.cooldown, { dash: 0, guard: 0, blast: BLAST.firstCooldown })
    this.resolved.clear()
    this.sent.clear()
  }

  setInput(x: number, z: number): void {
    this.inputX = x
    this.inputZ = z
  }

  /** `seconds`: one-way delay from this client to the owner of `seat` (both clients' latency). */
  setPeerDelay(seat: Seat, seconds: number): void {
    this.windows.set(seat, Math.max(HIT_WINDOW, 2 * seconds))
  }

  /** One step of own movement against the balls of other seats. Returns the contacts to send. */
  step(seconds: number, others: readonly { seat: Seat; ball: Motion }[], floor = Infinity): Contact[] {
    const dt = Math.min(Math.max(seconds, 0), MAX_STEP)
    this.clock += dt
    for (const kind of Object.keys(this.cooldown) as ('dash' | 'guard' | 'blast')[]) this.cooldown[kind] = Math.max(0, this.cooldown[kind] - dt)
    if (this.charging) this.chargeTime += dt
    this.dashLeft = Math.max(0, this.dashLeft - dt)
    this.guardLeft = Math.max(0, this.guardLeft - dt)
    if (this.out) return []
    const cap = this.rules.max_speed * (this.dashLeft > 0 ? SKILLS.dash.capScale : 1)
    // Off the shrunk floor but inside the edge: drift back toward the centre (no ring-out for standing still).
    const distance = Math.hypot(this.x, this.z)
    if (distance > floor && distance > 1e-3) {
      const pull = SHRINK.pull * Math.min(1, 0.4 + (distance - floor) / 2)
      this.vx -= (this.x / distance) * pull * dt
      this.vz -= (this.z / distance) * pull * dt
    }
    const handling = this.charging ? BLAST.slow : 1
    integrate(this, this.inputX * handling, this.inputZ * handling, dt, this.rules, cap)
    this.limit()
    const contacts: Contact[] = []
    for (const { seat, ball } of others) {
      const contact = touch(this, ball, this.rules)
      // Inside the window this pair already has its impulse: only keep the balls apart.
      if (!contact || this.recent(this.resolved, seat)) continue
      // Capped: the server drops a hit above twice the top speed.
      const impulse = Math.min(((1 + this.rules.restitution) * contact.closing) / 2, this.rules.max_speed * 1.9)
      // A dashing ball rams: it keeps more of its own speed and pushes the other at least `minPush`.
      const ram = this.dashLeft > 0
      const recoil = ram ? SKILLS.dash.recoil : 1
      const push = ram ? Math.min(Math.max(impulse * SKILLS.dash.ram, SKILLS.dash.minPush), this.rules.max_speed * 1.9) : impulse
      this.vx += impulse * recoil * contact.nx
      this.vz += impulse * recoil * contact.nz
      if (impulse >= BLAST.interruptImpulse) this.breakCharge()
      this.resolved.set(seat, this.clock)
      this.sent.set(seat, this.clock)
      contacts.push({ seat, jx: -push * contact.nx, jz: -push * contact.nz, closing: contact.closing })
    }
    // Same test as the server referee, on the same unrounded numbers the pose carries.
    if (Math.hypot(this.x, this.z) > this.rules.arena_radius) this.out = true
    return contacts
  }

  /** Applies the half of a contact that `seat` resolved. Returns false when it was not applied. */
  receiveHit(seat: Seat, jx: number, jz: number): boolean {
    // Both owners detected this contact, and each already applied its own half.
    if (this.out || this.recent(this.sent, seat)) return false
    const soften = this.guardLeft > 0 ? SKILLS.guard.soften : 1
    this.vx += jx * soften
    this.vz += jz * soften
    this.limit()
    this.resolved.set(seat, this.clock)
    if (Math.hypot(jx, jz) >= BLAST.interruptImpulse) this.breakCharge()
    return true
  }

  /**
   * Starts a skill if it is ready and the ball is in play. Returns where it was used (the origin the
   * game announces), or null. A dash needs a direction: the stick, else the current motion.
   */
  use(kind: 'dash' | 'guard'): { x: number; z: number } | null {
    if (this.out || this.cooldown[kind] > 0) return null
    if (kind === 'dash') {
      let dx = this.inputX
      let dz = this.inputZ
      if (Math.hypot(dx, dz) < 0.2) { dx = this.vx; dz = this.vz }
      const length = Math.hypot(dx, dz)
      if (length < 0.2) return null
      this.vx += (dx / length) * SKILLS.dash.kick
      this.vz += (dz / length) * SKILLS.dash.kick
      this.dashLeft = SKILLS.dash.duration
      this.limit(SKILLS.dash.capScale + 0.1)
      // Dashing out of a charge gives it up.
      if (this.charging) this.breakCharge(true)
    } else {
      this.guardLeft = SKILLS.guard.duration
    }
    this.cooldown[kind] = SKILLS[kind].cooldown
    return { x: this.x, z: this.z }
  }

  /** Starts holding a blast. False while it recharges, while already holding or when out of play. */
  startCharge(): boolean {
    if (this.out || this.charging || this.cooldown.blast > 0) return false
    this.charging = true
    this.chargeTime = 0
    return true
  }

  /**
   * Fires the held blast. Returns where and how strong (level 0..1), or null when nothing was held.
   * The longer the hold, the more the caster is thrown back and the longer the recharge.
   */
  release(): { x: number; z: number; level: number } | null {
    if (!this.charging) return null
    const level = chargeLevel(this.chargeTime)
    this.charging = false
    this.chargeTime = 0
    const speed = Math.hypot(this.vx, this.vz)
    if (speed > 0.5) {
      const kick = BLAST.recoil * (0.5 + level)
      this.vx -= (this.vx / speed) * kick
      this.vz -= (this.vz / speed) * kick
    }
    const { cooldown } = blastStats(level)
    this.cooldown.blast = cooldown
    this.blastTotal = cooldown
    return { x: this.x, z: this.z, level }
  }

  /** True once after a charge was broken by a hit, a blast or a dash. */
  takeBroken(): boolean {
    const broken = this.broken
    this.broken = false
    return broken
  }

  /** Gives up the held blast; `force` also breaks through a guard (a dash). */
  private breakCharge(force = false): void {
    if (!this.charging || (this.guardLeft > 0 && !force)) return
    this.charging = false
    this.chargeTime = 0
    this.broken = true
    this.cooldown.blast = Math.max(this.cooldown.blast, BLAST.interruptCooldown)
    this.blastTotal = BLAST.interruptCooldown
  }

  /**
   * A blast of charge `level` at `ox`, `oz`: pushes this ball away from that point when it is within
   * the blast's radius, with full power at the centre fading to 40% at the rim. A guard softens it,
   * unless the blast is strong enough to break it. Returns the push strength in 0..1, or 0.
   */
  receiveBlast(ox: number, oz: number, level = 0.3): number {
    if (this.out) return 0
    const dx = this.x - ox
    const dz = this.z - oz
    const distance = Math.hypot(dx, dz)
    const { radius, power } = blastStats(level)
    if (distance > radius) return 0
    const strength = 1 - 0.6 * (distance / radius)
    const nx = distance > 1e-3 ? dx / distance : 0
    const nz = distance > 1e-3 ? dz / distance : 1
    const pierced = level >= BLAST.pierce
    const soften = this.guardLeft > 0 && !pierced ? SKILLS.guard.soften : 1
    if (pierced) this.guardLeft = 0
    this.breakCharge(pierced)
    this.vx += nx * power * strength * soften
    this.vz += nz * power * strength * soften
    this.limit()
    return strength * soften
  }

  /** Keeps the ball under the absolute speed limit the server relays. */
  private limit(scale = ABSOLUTE_SPEED): void {
    const max = this.rules.max_speed * scale
    const speed = Math.hypot(this.vx, this.vz)
    if (speed > max) { this.vx *= max / speed; this.vz *= max / speed }
  }

  private recent(times: Map<Seat, number>, seat: Seat): boolean {
    const at = times.get(seat)
    return at !== undefined && this.clock - at < (this.windows.get(seat) ?? HIT_WINDOW)
  }
}

/** Input acceleration, damping, speed cap and movement for one step. */
export function integrate(ball: Motion, inputX: number, inputZ: number, dt: number, rules: Rules, cap = rules.max_speed): void {
  ball.vx += inputX * rules.accel * dt
  ball.vz += inputZ * rules.accel * dt
  const keep = Math.exp(-rules.damping * dt)
  ball.vx *= keep
  ball.vz *= keep
  const speed = Math.hypot(ball.vx, ball.vz)
  if (speed > cap) {
    // Above the cap (after a bump, dash or blast) the excess fades instead of snapping away.
    const kept = cap + (speed - cap) * Math.exp(-OVERSPEED_DECAY * dt)
    ball.vx *= kept / speed
    ball.vz *= kept / speed
  }
  ball.x += ball.vx * dt
  ball.z += ball.vz * dt
}

/**
 * Moves `own` fully out of an overlap with `other`; `other` is not changed. Returns the contact
 * normal (from `other` toward `own`) and the closing speed when the balls approach each other,
 * or null when they do not touch or already move apart.
 */
export function touch(own: Motion, other: Motion, rules: Rules): { nx: number; nz: number; closing: number } | null {
  const dx = own.x - other.x
  const dz = own.z - other.z
  const distance = Math.hypot(dx, dz)
  const minimum = rules.ball_radius * 2
  if (distance >= minimum) return null
  const nx = distance > 1e-6 ? dx / distance : 0
  const nz = distance > 1e-6 ? dz / distance : 1
  own.x = other.x + nx * minimum
  own.z = other.z + nz * minimum
  const closing = (other.vx - own.vx) * nx + (other.vz - own.vz) * nz
  return closing > 0 ? { nx, nz, closing } : null
}
