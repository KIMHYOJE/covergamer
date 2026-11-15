import * as THREE from 'three'
import type { Audio } from '../engine/audio'
import type { Renderer } from '../engine/renderer'
import type { Quality } from '../engine/save'
import { SEATS, type EventKind, type Hit, type Point, type Pose, type Role, type RoomState, type Rules, type Seat, type Skill, type SkillKind, type Welcome } from '../net/protocol'
import { Arena } from './arena'
import { BallView, RemoteTrack, SEAT_COLORS } from './balls'
import { ArenaCamera, cameraSide } from './camera'
import { CONFIG } from './config'
import { Effects } from './fx'
import { blastStats, BLAST, chargeLevel, floorRadius, OwnBall, SHRINK, SKILLS, type Motion } from './localBall'

export type Mode = 'attract' | 'online'

export type GameHooks = {
  /** A new server event (round start, ring-out, point, match end) for the HUD. */
  event(kind: EventKind, state: RoomState): void
  /** The arena starts shrinking. */
  shrink(): void
}

/** The own ball as `main.ts` publishes it. `urgent` asks for a pose now (after a bump or the edge). */
export type OwnPose = { round: number; x: number; z: number; vx: number; vz: number; urgent: boolean }
/** The half of a contact that the owner of seat `to` must apply, as `main.ts` sends it. */
export type OutgoingHit = { to: Seat; round: number; jx: number; jz: number }

/** A skill this client used, as `main.ts` sends it. */
export type OutgoingSkill = { kind: SkillKind; round: number; x: number; z: number; power: number }
/** Cooldowns for the HUD, and the blast charge (0..1, or -1 when not holding). */
export type SkillStatus = Record<'dash' | 'guard' | 'blast', { left: number; total: number }> & { charge: number }

/** Closing speed, in metres per second, from which a contact plays sound, particles and shake. */
const BUMP_EFFECT_SPEED = 1.5
const BUMP_EFFECT_COOLDOWN = 0.12
/** Closing speed from which a contact is a hard hit: heavier sound, a ring and more shake. */
const HARD_HIT_SPEED = 6

/**
 * One online match on this client. It simulates the own ball (`OwnBall`), draws every other ball
 * in present time (`RemoteTrack`), and renders camera, particles and sound locally. The server
 * sends phases, ring-outs and scores in `room` messages. `main.ts` owns the connection.
 */
export class Game {
  mode: Mode = 'attract'
  role: Role = 'spectator'
  state: RoomState | null = null
  reducedMotion = false
  private rules: Rules | null = null
  private spawn: Record<Seat, Point> = { p1: { x: 0, z: 4 }, p2: { x: 0, z: -4 }, p3: { x: 4, z: 0 }, p4: { x: -4, z: 0 } }
  private readonly arena: Arena
  private readonly cam = new ArenaCamera()
  private readonly fx = new Effects()
  private readonly own = new OwnBall()
  private readonly balls = {} as Record<Seat, BallView>
  private readonly remote = {} as Record<Seat, RemoteTrack>
  private lastEventSeq = -1
  private round = -1
  private phaseEndsAt = 0
  private lastCount = 0
  private time = 0
  private urgent = false
  private hits: OutgoingHit[] = []
  private ownFell = false
  private bumpCooldown = 0
  private chargeClock = 0
  /** When the current round went live on this client (ms), 0 outside a live round. */
  private liveSince = 0
  private shrinkNotified = false
  private skills: OutgoingSkill[] = []
  private readonly remoteFx = Object.fromEntries(SEATS.map(seat => [seat, { dash: 0, guard: 0, charge: -1 }])) as Record<Seat, { dash: number; guard: number; charge: number }>
  private readonly trailClock = Object.fromEntries(SEATS.map(seat => [seat, 0])) as Record<Seat, number>

  constructor(private readonly renderer: Renderer, private readonly audio: Audio, private readonly hooks: GameHooks) {
    this.arena = new Arena(renderer.shadowMapSize)
    for (const seat of SEATS) {
      this.balls[seat] = new BallView(SEAT_COLORS[seat])
      this.remote[seat] = new RemoteTrack()
      this.arena.scene.add(this.balls[seat].root)
    }
    this.arena.scene.add(this.fx.mesh, this.fx.rings)
  }

  get camera(): THREE.PerspectiveCamera {
    return this.cam.camera
  }

  /** World direction from the arena centre to this player's camera; screen-up points away from it. */
  get side(): Point {
    return this.cam.side
  }

  /** Seconds left in the current timed phase (countdown, point, ended). */
  phaseSeconds(nowMs = performance.now()): number {
    return Math.max(0, (this.phaseEndsAt - nowMs) / 1000)
  }

  welcome(message: Welcome): void {
    this.mode = 'online'
    this.role = message.role
    this.state = null
    this.lastEventSeq = -1
    this.round = -1
    this.rules = message.rules
    this.spawn = message.spawn
    this.cam.setSide(cameraSide(message.role, message.spawn))
    this.arena.setRadius(message.rules.arena_radius)
    this.own.configure(message.rules)
    for (const seat of SEATS) {
      this.balls[seat].setRadius(message.rules.ball_radius)
      this.balls[seat].setOwn(seat === message.role)
    }
    this.placeAll()
  }

  /** A validated `room` message. */
  room(state: RoomState, nowMs: number): void {
    this.phaseEndsAt = nowMs + state.phase_ends_in_ms
    const previous = this.state
    this.state = state
    if (state.phase !== 'live') this.liveSince = 0
    else if (previous?.phase !== 'live' || previous.round !== state.round || !this.liveSince) {
      this.liveSince = nowMs
      this.shrinkNotified = false
    }
    // Each round starts from the spawns, and so does the wait after a void round.
    if (state.round !== this.round || (state.phase === 'waiting' && previous?.phase !== 'waiting')) this.placeAll()
    this.round = state.round
    if (this.lastEventSeq < 0 || !previous) {
      this.lastEventSeq = state.event.seq
      return
    }
    if (state.event.seq > this.lastEventSeq) {
      this.lastEventSeq = state.event.seq
      this.onEvent(state)
    }
  }

  /** A validated pose of a ball this client does not own. `latency` is this client's one-way latency in seconds. */
  pose(pose: Pose, latency: number, nowMs: number): void {
    if (!this.state || pose.round !== this.state.round || pose.seat === this.role) return
    this.remote[pose.seat].push(pose, latency, nowMs / 1000)
    this.own.setPeerDelay(pose.seat, latency + pose.lat / 1000)
  }

  /** The own ball to publish, or null when this client has no ball in the live round. */
  ownPose(): OwnPose | null {
    if (!this.ownsLiveBall()) return null
    const { x, z, vx, vz } = this.own
    return { round: this.state!.round, x, z, vx, vz, urgent: this.urgent }
  }

  posted(): void {
    this.urgent = false
  }

  /** Contacts this client resolved since the last call; send each one before the next pose. */
  takeHits(): OutgoingHit[] {
    const hits = this.hits
    this.hits = []
    return hits
  }

  /** A validated `hit`: another owner resolved a contact with the own ball and sent its half. */
  hit(message: Hit): void {
    if (!this.ownsLiveBall() || message.round !== this.state!.round) return
    if (!this.own.receiveHit(message.seat, message.jx, message.jz)) return
    this.urgent = true
    // The impulse is half of the shared one, (1 + restitution) * closing / 2.
    const closing = (2 * Math.hypot(message.jx, message.jz)) / (1 + (this.rules?.restitution ?? 1))
    if (closing >= BUMP_EFFECT_SPEED) this.bumpEffects(this.remote[message.seat], closing)
  }

  /** The skills this client used since the last call; send each one before the next pose. */
  takeSkills(): OutgoingSkill[] {
    const skills = this.skills
    this.skills = []
    return skills
  }

  /** Seconds until each skill is ready again, with its full cooldown, for the HUD. */
  skillStatus(): SkillStatus {
    const { cooldown } = this.own
    return {
      dash: { left: cooldown.dash, total: SKILLS.dash.cooldown },
      guard: { left: cooldown.guard, total: SKILLS.guard.cooldown },
      blast: { left: cooldown.blast, total: this.own.blastTotal },
      charge: this.own.charging && !this.own.out ? chargeLevel(this.own.chargeTime) : -1,
    }
  }

  /** The player pressed a skill. Does nothing while it recharges or the ball is not in play. */
  useSkill(kind: 'dash' | 'guard'): void {
    if (this.mode !== 'online' || !this.ownsLiveBall()) return
    const wasCharging = this.own.charging
    const origin = this.own.use(kind)
    if (!origin) return
    this.urgent = true
    this.skills.push({ kind, round: this.state!.round, power: 0, ...origin })
    this.skillEffects(this.role as Seat, kind, origin.x, origin.z, true)
    if (wasCharging && !this.own.charging) this.chargeBroken()
  }

  /** The blast button went down: start holding. Returns whether a charge started. */
  startBlast(): boolean {
    if (this.mode !== 'online' || !this.ownsLiveBall() || !this.own.startCharge()) return false
    this.urgent = true
    this.chargeClock = 0
    this.skills.push({ kind: 'charge', round: this.state!.round, power: 0, x: this.own.x, z: this.own.z })
    this.audio.blip(320, 0.16)
    return true
  }

  /** The blast button came up (or the charge ran out): fire what has been charged. */
  releaseBlast(): void {
    if (this.mode !== 'online' || !this.ownsLiveBall()) return
    const shot = this.own.release()
    if (!shot) return
    this.urgent = true
    this.skills.push({ kind: 'blast', round: this.state!.round, power: shot.level, x: shot.x, z: shot.z })
    this.skillEffects(this.role as Seat, 'blast', shot.x, shot.z, true, shot.level)
  }

  /** A validated `skill` of another player: a blast may push the own ball; every kind is drawn. */
  skill(message: Skill): void {
    if (!this.state || message.round !== this.state.round || message.seat === this.role) return
    if (message.kind === 'blast' && this.ownsLiveBall()) {
      const wasCharging = this.own.charging
      const strength = this.own.receiveBlast(message.x, message.z, message.power)
      if (strength > 0) {
        this.urgent = true
        this.cam.addShake(CONFIG.look.bumpShake * (1 + 2.5 * strength * (0.5 + message.power)))
        if (wasCharging && !this.own.charging) this.chargeBroken()
      }
    }
    this.skillEffects(message.seat, message.kind, message.x, message.z, false, message.power)
  }

  /** Back to the title orbit; the connection is already closed by the caller. */
  leave(): void {
    this.mode = 'attract'
    this.role = 'spectator'
    this.state = null
    for (const seat of SEATS) this.balls[seat].setOwn(false)
    this.placeAll()
    this.fx.clear()
  }

  /** The world direction the player is pushing (length at most 1). */
  setInput(x: number, z: number): void {
    this.own.setInput(x, z)
  }

  setQuality(quality: Quality): void {
    this.renderer.applyQuality(quality)
    const size = this.renderer.shadowMapSize
    const shadow = this.arena.sun.shadow
    shadow.map?.dispose()
    shadow.map = null
    shadow.mapSize.set(size, size)
    // Shadow support is compiled into shaders: recompile after toggling shadows at runtime.
    this.arena.scene.traverse(obj => {
      const material = (obj as THREE.Mesh).material
      for (const m of Array.isArray(material) ? material : material ? [material] : []) m.needsUpdate = true
    })
  }

  /** The floor radius now: the full arena until the shrink starts, outside a live round always full. */
  floor(): number {
    const full = this.rules?.arena_radius ?? 10
    if (this.mode !== 'online' || this.state?.phase !== 'live' || !this.liveSince) return full
    return floorRadius(full, (performance.now() - this.liveSince) / 1000)
  }

  step(dt: number): void {
    this.bumpCooldown = Math.max(0, this.bumpCooldown - dt)
    if (this.mode !== 'online' || !this.ownsLiveBall()) return
    const others = SEATS.filter(seat => seat !== this.role && this.inPlay(seat)).map(seat => ({ seat, ball: this.remote[seat] }))
    const wasOut = this.own.out
    const round = this.state!.round
    const wasCharging = this.own.charging
    for (const contact of this.own.step(dt, others, this.floor())) {
      this.urgent = true
      this.hits.push({ to: contact.seat, round, jx: contact.jx, jz: contact.jz })
      if (contact.closing >= BUMP_EFFECT_SPEED) this.bumpEffects(this.remote[contact.seat], contact.closing)
    }
    if (wasCharging && !this.own.charging && this.own.takeBroken()) this.chargeBroken()
    // Held for the longest charge plus the grace time: it fires by itself.
    if (this.own.charging && this.own.chargeTime >= BLAST.autoRelease) this.releaseBlast()
    if (this.own.out && !wasOut) {
      // Optimistic: fall at once; the server's ring-out event confirms it and scores the round.
      this.urgent = true
      this.ownFell = true
      this.audio.play('fall')
      this.fx.burst(new THREE.Vector3(this.own.x, 0.5, this.own.z), SEAT_COLORS[this.role as Seat], 46, 9)
      this.fx.shockwave(this.own.x, this.own.z, SEAT_COLORS[this.role as Seat], 3.2, 0.7)
    }
  }

  render(frameSeconds: number): void {
    this.time += frameSeconds
    const state = this.state
    if (this.mode === 'attract' || !state) {
      this.cam.orbit(frameSeconds)
      for (const seat of SEATS) {
        this.balls[seat].root.visible = seat === 'p1' || seat === 'p2'
        this.balls[seat].update(this.spawn[seat].x, this.spawn[seat].z, 0, 0, false, frameSeconds, this.time)
      }
    } else {
      const now = performance.now() / 1000
      const radius = this.rules?.arena_radius ?? 10
      let own: Point | null = null
      for (const seat of SEATS) {
        const seatState = state.seats[seat]
        const shown = state.phase === 'waiting' || state.phase === 'countdown' ? seatState.connected : seatState.playing
        this.balls[seat].root.visible = shown
        if (!shown) continue
        const mine = seat === this.role
        if (!mine) this.remote[seat].update(now, frameSeconds)
        const ball: Motion = mine ? this.own : this.remote[seat]
        // Fall as soon as the owner's report crosses the edge; the server confirms with `out`.
        const out = seatState.out || (mine ? this.own.out : this.remote[seat].reportedOutside(radius))
        this.balls[seat].update(ball.x, ball.z, ball.vx, ball.vz, out, frameSeconds, this.time)
        this.ballEffects(seat, mine, ball, out, frameSeconds)
        if (mine && seatState.playing) own = ball
      }
      this.cam.update(own, frameSeconds, this.reducedMotion)
      this.countdownBeep(state)
    }
    const floor = this.floor()
    this.arena.setFloor(floor, this.time)
    if (!this.shrinkNotified && this.liveSince && performance.now() - this.liveSince >= SHRINK.delay * 1000) {
      this.shrinkNotified = true
      this.hooks.shrink()
    }
    this.fx.update(frameSeconds)
    this.renderer.render(this.arena.scene, this.cam.camera)
  }

  private ownsLiveBall(): boolean {
    const state = this.state
    if (!state || this.role === 'spectator' || state.phase !== 'live') return false
    const seat = state.seats[this.role]
    return seat.playing && !seat.out
  }

  private inPlay(seat: Seat): boolean {
    const value = this.state?.seats[seat]
    return !!value && value.playing && !value.out
  }

  private placeAll(): void {
    for (const seat of SEATS) this.remote[seat].place(this.spawn[seat].x, this.spawn[seat].z)
    if (this.role !== 'spectator') this.own.place(this.spawn[this.role].x, this.spawn[this.role].z)
    this.urgent = false
    this.hits = []
    this.ownFell = false
    this.skills = []
    for (const seat of SEATS) Object.assign(this.remoteFx[seat], { dash: 0, guard: 0, charge: -1 })
  }

  /** Bump sparks grow with the closing speed; a hard hit adds a ring, a deeper sound and more shake. */
  private bumpEffects(other: Motion, closing: number): void {
    if (this.bumpCooldown > 0) return
    this.bumpCooldown = BUMP_EFFECT_COOLDOWN
    const at = new THREE.Vector3((this.own.x + other.x) / 2, 0.8, (this.own.z + other.z) / 2)
    const hard = closing >= HARD_HIT_SPEED
    this.audio.play(hard ? 'hard' : 'bump')
    this.fx.burst(at, '#ffffff', Math.round(14 + closing * 3), 5 + closing * 0.7)
    if (hard) {
      this.fx.burst(at, '#ffd04a', 16, 9)
      this.fx.shockwave(at.x, at.z, '#ffffff', 1.4 + closing * 0.18, 0.4)
    }
    this.cam.addShake(CONFIG.look.bumpShake * (0.6 + Math.min(closing, 14) / 7))
  }

  /** Sound, particles and rings for a skill; `mine` adds camera shake for the own ball's skills. */
  private skillEffects(seat: Seat, kind: SkillKind, x: number, z: number, mine: boolean, power = 0): void {
    const color = SEAT_COLORS[seat]
    const at = new THREE.Vector3(x, 0.6, z)
    if (kind === 'charge') {
      // Others see the reach grow on the floor; the own ball starts it in `startBlast()`.
      if (!mine) { this.remoteFx[seat].charge = 0; this.audio.blip(260, 0.07) }
    } else if (kind === 'dash') {
      this.audio.play('dash')
      this.fx.burst(at, '#ffffff', 18, 7)
      this.fx.shockwave(x, z, color, 1.8, 0.35)
      if (!mine) this.remoteFx[seat].dash = SKILLS.dash.duration
      else this.cam.addShake(CONFIG.look.bumpShake * 0.8)
    } else if (kind === 'guard') {
      this.audio.play('guard')
      this.fx.burst(at, '#9fe8ff', 20, 5)
      this.fx.shockwave(x, z, '#9fe8ff', 2.2, 0.5)
      if (!mine) this.remoteFx[seat].guard = SKILLS.guard.duration
    } else {
      // A blast: bigger charge, bigger everything.
      const { radius } = blastStats(power)
      this.remoteFx[seat].charge = -1
      this.audio.play('blast')
      if (power > 0.6) this.audio.play('hard')
      this.fx.radial(at, color, Math.round(36 + power * 50), 10 + power * 8)
      this.fx.burst(at, '#ffffff', Math.round(20 + power * 24), 8 + power * 5)
      this.fx.burst(new THREE.Vector3(x, 1.2, z), '#ffd04a', Math.round(14 + power * 24), 7 + power * 4)
      this.fx.shockwave(x, z, color, radius, 0.5 + power * 0.25)
      this.fx.shockwave(x, z, '#ffffff', radius * 0.7, 0.4 + power * 0.2)
      if (power >= BLAST.pierce) this.fx.shockwave(x, z, '#ffd04a', radius * 1.05, 0.9)
      this.cam.addShake(CONFIG.look.bumpShake * (mine ? 2 + power * 3 : 1 + power * 1.5))
    }
  }

  /** Specks drawn in toward a charging ball; the own ball also beeps, higher as it fills. */
  private chargeEffects(seat: Seat, mine: boolean, ball: Motion, level: number, reach: number, dt: number): void {
    const at = new THREE.Vector3(ball.x, 0.8, ball.z)
    this.fx.implode(at, level >= 1 ? '#ffd04a' : SEAT_COLORS[seat], reach, level >= 1 ? 3 : 1 + Math.round(level * 2))
    if (!mine) return
    this.chargeClock -= dt
    if (this.chargeClock > 0) return
    this.chargeClock = level >= 1 ? 0.07 : 0.16 - level * 0.07
    this.audio.blip(360 + level * 900, 0.1 + level * 0.05)
  }

  /** The held blast was broken by a hit or a blast. */
  private chargeBroken(): void {
    this.audio.play('bump')
    this.fx.burst(new THREE.Vector3(this.own.x, 0.9, this.own.z), '#888899', 18, 6)
    this.fx.shockwave(this.own.x, this.own.z, '#888899', 2.2, 0.3)
  }

  /** Dash glow, guard bubble and a speed trail behind a fast ball. */
  private ballEffects(seat: Seat, mine: boolean, ball: Motion, out: boolean, dt: number): void {
    const timers = this.remoteFx[seat]
    if (!mine) {
      timers.dash = Math.max(0, timers.dash - dt)
      timers.guard = Math.max(0, timers.guard - dt)
    }
    const dashing = mine ? this.own.dashLeft > 0 : timers.dash > 0
    const guarding = mine ? this.own.guardLeft > 0 : timers.guard > 0
    let charge = -1
    if (mine) {
      if (this.own.charging && !out) charge = chargeLevel(this.own.chargeTime)
    } else if (timers.charge >= 0) {
      timers.charge += dt
      // A rival's charge that never ended in a blast (it was broken) fades after the longest hold.
      if (timers.charge > BLAST.autoRelease + 0.3) timers.charge = -1
      else if (!out) charge = chargeLevel(timers.charge)
    }
    const reach = blastStats(Math.max(charge, 0)).radius
    this.balls[seat].setState(dashing, guarding, charge, reach)
    if (charge >= 0) this.chargeEffects(seat, mine, ball, charge, reach, dt)
    this.trailClock[seat] -= dt
    if (out || this.trailClock[seat] > 0) return
    const speed = Math.hypot(ball.vx, ball.vz)
    if (!dashing && speed < 4.5) return
    this.trailClock[seat] = dashing ? 0.012 : 0.035
    const radius = this.rules?.ball_radius ?? 0.8
    const behind = new THREE.Vector3(ball.x - ball.vx * 0.03, radius * 0.9, ball.z - ball.vz * 0.03)
    this.fx.trail(behind, dashing ? '#ffffff' : SEAT_COLORS[seat], dashing ? 1.7 : 0.9 + Math.min(speed, 12) / 24)
  }

  private countdownBeep(state: RoomState): void {
    const count = state.phase === 'countdown' ? Math.ceil(this.phaseSeconds()) : 0
    if (count > 0 && count !== this.lastCount) this.audio.play('count')
    this.lastCount = count
  }

  private onEvent(state: RoomState): void {
    const { kind, seat } = state.event
    if (kind === 'round') {
      this.audio.play('go')
    } else if (kind === 'ringout' && seat && seat !== this.role) {
      const ball = this.remote[seat]
      this.audio.play('fall')
      this.fx.burst(new THREE.Vector3(ball.x, 0.5, ball.z), SEAT_COLORS[seat], 46, 9)
      this.fx.shockwave(ball.x, ball.z, SEAT_COLORS[seat], 3.2, 0.7)
    } else if (kind === 'ringout' && seat === this.role && !this.ownFell) {
      // The server saw the own ball cross before this client did (for example after a reconnect).
      this.audio.play('fall')
    } else if (kind === 'match') {
      this.audio.play(this.role === 'spectator' || state.winner === this.role ? 'win' : 'lose')
      if (state.winner) this.fx.burst(new THREE.Vector3(0, 1, 0), SEAT_COLORS[state.winner], 60, 10)
    }
    this.hooks.event(kind, state)
  }
}
