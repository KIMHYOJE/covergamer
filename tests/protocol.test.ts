import { describe, expect, it } from 'vitest'
import { RemoteTrack } from '../src/game/balls'
import { cameraSide, stickToWorld } from '../src/game/camera'
import { CONFIG } from '../src/game/config'
import { BLAST, blastStats, chargeLevel, floorRadius, HIT_WINDOW, OwnBall, SHRINK, SKILLS } from '../src/game/localBall'
import { bootstrapUrl, validEndpoint } from '../src/net/connection'
import { BUILD, decode, generateRoom, sanitizeRoom, validRoom, type Pose } from '../src/net/protocol'

const RULES = { arena_radius: 10, ball_radius: 0.8, accel: 13, damping: 0.55, max_speed: 9, restitution: 0.95, win_score: 3 }
const SPAWN = { p1: { x: 0, z: 4 }, p2: { x: 0, z: -4 }, p3: { x: 4, z: 0 }, p4: { x: -4, z: 0 } }
const seat = (patch: Record<string, unknown> = {}) => ({ connected: true, playing: true, out: false, score: 0, ...patch })
const room = (patch: Record<string, unknown> = {}) => JSON.stringify({
  type: 'room', marker: BUILD, room: 'ROOM1', seq: 1, round: 1, phase: 'live', phase_ends_in_ms: 0,
  seats: { p1: seat(), p2: seat(), p3: seat({ connected: false, playing: false }), p4: seat({ connected: false, playing: false }) },
  winner: '', event: { seq: 0, kind: '', seat: '' }, ...patch,
})
const welcome = (patch: Record<string, unknown> = {}) => JSON.stringify({
  type: 'welcome', marker: BUILD, room: 'ROOM1', role: 'p1', resume_token: 'x'.repeat(32), rules: RULES, spawn: SPAWN, ...patch,
})
const pose = (patch: Partial<Pose> = {}): Pose => ({
  type: 'pose', marker: BUILD, room: 'ROOM1', seat: 'p2', round: 1, seq: 1, x: 0, z: -4, vx: 0, vz: 0, lat: 0, ...patch,
})

describe('protocol', () => {
  it('accepts valid welcome, room, pose and pong messages for this build and room only', () => {
    expect(decode(welcome(), 'ROOM1', -1)?.type).toBe('welcome')
    expect(decode(welcome({ role: 'p4' }), 'ROOM1', -1)?.type).toBe('welcome')
    expect(decode(room(), 'ROOM1', -1)?.type).toBe('room')
    expect(decode(JSON.stringify(pose({ seat: 'p3' })), 'ROOM1', -1)?.type).toBe('pose')
    expect(decode(JSON.stringify({ type: 'pong', marker: BUILD, room: 'ROOM1', t: 5 }), 'ROOM1', -1)?.type).toBe('pong')
    expect(decode(JSON.stringify({ type: 'hit', marker: BUILD, room: 'ROOM1', seat: 'p2', round: 1, jx: 3, jz: 0 }), 'ROOM1', -1)?.type).toBe('hit')
    expect(decode(JSON.stringify({ type: 'hit', marker: BUILD, room: 'ROOM1', seat: 'p2', round: 1, jx: 1e6, jz: 0 }), 'ROOM1', -1)).toBeNull()
    expect(decode(welcome({ marker: 'ring-out-v1' }), 'ROOM1', -1)).toBeNull()
    const skill = { type: 'skill', marker: BUILD, room: 'ROOM1', seat: 'p2', kind: 'blast', round: 1, x: 1, z: -2, power: 0.5 }
    expect(decode(JSON.stringify({ ...skill, kind: 'charge', power: 0 }), 'ROOM1', -1)?.type).toBe('skill')
    expect(decode(JSON.stringify({ ...skill, power: 1.5 }), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify({ ...skill, power: -0.1 }), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify({ ...skill, power: undefined }), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify(skill), 'ROOM1', -1)?.type).toBe('skill')
    expect(decode(JSON.stringify({ ...skill, kind: 'nuke' }), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify({ ...skill, seat: 'p9' }), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify({ ...skill, x: 1e6 }), 'ROOM1', -1)).toBeNull()
    expect(decode(room(), 'OTHER', -1)).toBeNull()
  })

  it('rejects stale, malformed or unbounded messages', () => {
    expect(decode(room({ seq: 1 }), 'ROOM1', 1)).toBeNull()
    expect(decode(room({ phase: 'paused' }), 'ROOM1', -1)).toBeNull()
    expect(decode(room({ winner: 'p5' }), 'ROOM1', -1)).toBeNull()
    expect(decode(room({ event: { seq: 1, kind: 'bump', seat: '' } }), 'ROOM1', -1)).toBeNull()
    expect(decode(room({ seats: { p1: seat(), p2: seat(), p3: seat() } }), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify(pose({ x: Infinity })), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify(pose({ x: 1e6 })), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify(pose({ lat: 5000 })), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify(pose({ seat: 'spectator' as never })), 'ROOM1', -1)).toBeNull()
    expect(decode(welcome({ role: 'admin' }), 'ROOM1', -1)).toBeNull()
    expect(decode(welcome({ resume_token: 'short' }), 'ROOM1', -1)).toBeNull()
    expect(decode(welcome({ rules: { ...RULES, ball_radius: 20 } }), 'ROOM1', -1)).toBeNull()
    expect(decode(welcome({ spawn: { ...SPAWN, p4: { x: 50, z: 0 } } }), 'ROOM1', -1)).toBeNull()
    expect(decode('{nope', 'ROOM1', -1)).toBeNull()
    expect(decode('x'.repeat(5000), 'ROOM1', -1)).toBeNull()
  })

  it('normalizes room codes and only connects to safe endpoints', () => {
    expect(sanitizeRoom(' ab-c1 ')).toBe('ABC1')
    expect(validRoom('ABC')).toBe(false)
    expect(validRoom(generateRoom(() => 0.5))).toBe(true)
    expect(validEndpoint('wss://game.example.com/ws')).toBe(true)
    expect(validEndpoint('ws://127.0.0.1:8787/ws')).toBe(true)
    expect(validEndpoint('ws://game.example.com/ws')).toBe(false)
    expect(validEndpoint('wss://user@game.example.com/ws')).toBe(false)
    expect(bootstrapUrl('https://x.dev/app/index.html?room=AB12#top')).toBe('https://x.dev/app/multiplayer/bootstrap.json')
    expect(bootstrapUrl('https://x.dev/game/__manus__/game-preview/abc/')).toBe('https://x.dev/game/multiplayer/bootstrap.json')
  })
})

describe('client-owned movement', () => {
  const expectDirection = (actual: { x: number; z: number }, x: number, z: number) => {
    expect(actual.x).toBeCloseTo(x)
    expect(actual.z).toBeCloseTo(z)
  }

  it('maps screen-up toward the arena centre for each seat', () => {
    for (const [role, up, right] of [
      ['p1', [0, -1], [1, 0]], ['p2', [0, 1], [-1, 0]], ['p3', [-1, 0], [0, -1]], ['p4', [1, 0], [0, 1]],
    ] as const) {
      const side = cameraSide(role, SPAWN)
      expectDirection(stickToWorld(side, 0, 1), up[0], up[1])
      expectDirection(stickToWorld(side, 1, 0), right[0], right[1])
    }
  })

  it('moves the own ball at once and reports the edge crossing itself', () => {
    const own = new OwnBall()
    own.configure(RULES)
    own.place(0, 4)
    own.setInput(1, 0)
    own.step(1 / 60, [])
    expect(own.x).toBeGreaterThan(0)
    own.place(9.9, 0)
    own.setInput(1, 0)
    for (let i = 0; i < 30 && !own.out; i += 1) own.step(1 / 60, [])
    expect(own.out).toBe(true)
    // An out ball holds the pose where it crossed while the server confirms the ring-out.
    const crossed = { x: own.x, z: own.z }
    own.setInput(-1, 0)
    own.step(1 / 60, [])
    expect({ x: own.x, z: own.z }).toEqual(crossed)
  })
  it('keeps a ball that a touch pushed past the edge outside, even when it moves inward', () => {
    const own = new OwnBall()
    own.configure(RULES)
    own.place(9.5, 0)
    own.vx = -5
    // The other ball moves away faster, so the touch only separates the balls and has no impulse.
    expect(own.step(1 / 60, [{ seat: 'p2', ball: { x: 8.6, z: 0, vx: -6, vz: 0 } }])).toEqual([])
    expect(own.out).toBe(true)
    for (let i = 0; i < 10; i += 1) own.step(1 / 60, [])
    expect(Math.hypot(own.x, own.z)).toBeGreaterThan(RULES.arena_radius)
  })

  const pair = (aVx: number, bVx: number) => {
    const a = new OwnBall(), b = new OwnBall()
    a.configure(RULES)
    b.configure(RULES)
    a.place(-0.7, 0)
    b.place(0.7, 0)
    a.vx = aVx
    b.vx = bVx
    return { a, b, aView: { x: 0.7, z: 0, vx: bVx, vz: 0 }, bView: { x: -0.7, z: 0, vx: aVx, vz: 0 } }
  }

  it('sends the other half of a contact that only one owner detected', () => {
    // p1 runs into a resting p2. p2 cannot see the overlap, so only p1's hit moves it.
    const { a, b, aView } = pair(6, 0)
    const [contact] = a.step(1e-6, [{ seat: 'p2', ball: aView }])
    expect(contact.seat).toBe('p2')
    expect(contact.closing).toBeCloseTo(6)
    expect(a.vx).toBeCloseTo(6 - 5.85)
    expect(b.receiveHit('p1', contact.jx, contact.jz)).toBe(true)
    expect(b.vx).toBeCloseTo(5.85)
    // The pair has its impulse: p2's later view of the overlap only separates the balls.
    expect(b.step(1e-6, [{ seat: 'p1', ball: { x: 0, z: 0, vx: 6, vz: 0 } }])).toEqual([])
    expect(b.vx).toBeCloseTo(5.85)
    expect(b.x).toBeCloseTo(1.6)
  })

  it('applies a contact once when both owners detect it', () => {
    const { a, b, aView, bView } = pair(6, -6)
    const [fromA] = a.step(1e-6, [{ seat: 'p2', ball: aView }])
    const [fromB] = b.step(1e-6, [{ seat: 'p1', ball: bView }])
    // Each applied its own half and ignores the half the other sends.
    expect(b.receiveHit('p1', fromA.jx, fromA.jz)).toBe(false)
    expect(a.receiveHit('p2', fromB.jx, fromB.jz)).toBe(false)
    expect(a.vx).toBeCloseTo(-5.7)
    expect(b.vx).toBeCloseTo(5.7)
    // After the window a new contact counts again.
    for (let i = 0; i * 0.05 <= HIT_WINDOW; i += 1) a.step(0.05, [])
    expect(a.receiveHit('p2', 1, 0)).toBe(true)
  })
  it('widens the contact window to the client-to-client round trip', () => {
    const { a, b, aView, bView } = pair(6, -6)
    // 120 ms each way between the two clients: the window becomes 0.48 s.
    b.setPeerDelay('p1', 0.24)
    const [fromA] = a.step(1e-6, [{ seat: 'p2', ball: aView }])
    b.step(1e-6, [{ seat: 'p1', ball: bView }])
    // p1's half arrives 0.3 s later, past the shortest window: p2 already applied it.
    for (let i = 0; i < 6; i += 1) b.step(0.05, [])
    expect(b.receiveHit('p1', fromA.jx, fromA.jz)).toBe(false)
    for (let i = 0; i < 4; i += 1) b.step(0.05, [])
    expect(b.receiveHit('p1', 1, 0)).toBe(true)
  })

  it('keeps a steadily moving remote ball on its true position between poses', () => {
    const track = new RemoteTrack()
    track.place(0, -4)
    // 30 Hz poses, 60 Hz frames, 40 ms sender latency and 30 ms own latency, at a constant 6 m/s.
    let worst = 0
    for (let frame = 0; frame < 120; frame += 1) {
      const now = 10 + frame / 60
      if (frame % 2 === 0) {
        const sentAt = now - 0.04 - 0.03
        track.push(pose({ seq: frame + 1, x: 0, z: -4 + 6 * (sentAt - 10), vz: 6, lat: 40 }), 0.03, now)
      }
      track.update(now, 1 / 60)
      if (frame > 10) worst = Math.max(worst, Math.abs(track.z - (-4 + 6 * (now - 10))))
    }
    expect(worst).toBeLessThan(0.01)
  })

  it('draws another ball in present time and ignores out-of-order poses', () => {
    const track = new RemoteTrack()
    track.place(0, -4)
    // The pose is 50 ms old when sent and this client is 50 ms from the server: project 0.1 s ahead.
    track.push(pose({ seq: 2, x: 0, z: -4, vz: 5, lat: 50 }), 0.05, 10)
    for (let i = 0; i < 60; i += 1) track.update(10, 1 / 60)
    expect(track.z).toBeCloseTo(-3.5, 1)
    track.push(pose({ seq: 1, z: 3 }), 0.05, 10)
    track.update(10, 1)
    expect(track.z).toBeCloseTo(-3.5, 1)
    // The projection is capped at `net.maxLead` when poses stop.
    for (let i = 0; i < 60; i += 1) track.update(12, 1 / 60)
    expect(track.z).toBeCloseTo(-4 + 5 * CONFIG.net.maxLead, 1)
    expect(track.reportedOutside(RULES.arena_radius)).toBe(false)
    track.push(pose({ seq: 3, x: 10.5, z: 0 }), 0.05, 12)
    expect(track.reportedOutside(RULES.arena_radius)).toBe(true)
  })
})

describe('skills', () => {
  const ready = () => {
    const own = new OwnBall()
    own.configure(RULES)
    own.place(0, 0)
    return own
  }
  const settle = (own: OwnBall, seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) own.step(1 / 60, [])
  }

  it('dash needs a direction, adds speed past the normal cap and then fades back', () => {
    const own = ready()
    own.configure({ ...RULES, arena_radius: 200 })
    expect(own.use('dash')).toBeNull()
    expect(own.cooldown.dash).toBe(0)
    own.setInput(1, 0)
    expect(own.use('dash')).toEqual({ x: 0, z: 0 })
    expect(own.vx).toBeGreaterThan(RULES.max_speed * 0.8)
    expect(own.cooldown.dash).toBe(SKILLS.dash.cooldown)
    own.step(1 / 60, [])
    expect(Math.hypot(own.vx, own.vz)).toBeGreaterThan(RULES.max_speed)
    expect(Math.hypot(own.vx, own.vz)).toBeLessThanOrEqual(RULES.max_speed * 1.9)
    own.setInput(0, 0)
    settle(own, 3)
    expect(Math.hypot(own.vx, own.vz)).toBeLessThan(RULES.max_speed)
    expect(own.use('dash')).not.toBeNull()
  })

  it('a skill is ready only once its cooldown has run out, and not when out of play', () => {
    const own = ready()
    expect(own.use('guard')).not.toBeNull()
    expect(own.use('guard')).toBeNull()
    settle(own, SKILLS.guard.cooldown + 0.1)
    expect(own.use('guard')).not.toBeNull()
    own.out = true
    expect(own.use('dash')).toBeNull()
    expect(own.startCharge()).toBe(false)
  })

  it('blast waits a few seconds at the start of a round', () => {
    const own = ready()
    expect(own.startCharge()).toBe(false)
    settle(own, BLAST.firstCooldown + 0.1)
    expect(own.startCharge()).toBe(true)
  })

  it('a blast pushes balls inside its radius away from the origin, harder near the centre', () => {
    const near = ready()
    near.place(1, 0)
    const far = ready()
    far.place(blastStats(0.3).radius - 0.5, 0)
    const outside = ready()
    outside.place(blastStats(0.3).radius + 0.5, 0)
    expect(near.receiveBlast(0, 0)).toBeGreaterThan(far.receiveBlast(0, 0))
    expect(near.vx).toBeGreaterThan(far.vx)
    expect(far.vx).toBeGreaterThan(0)
    expect(outside.receiveBlast(0, 0)).toBe(0)
    expect(outside.vx).toBe(0)
    expect(Math.hypot(near.vx, near.vz)).toBeLessThanOrEqual(RULES.max_speed * 1.9)
  })

  it('guard softens blasts and hits, and ends when its time is up', () => {
    const plain = ready()
    plain.place(1, 0)
    plain.receiveBlast(0, 0)
    const guarded = ready()
    guarded.place(1, 0)
    guarded.use('guard')
    guarded.receiveBlast(0, 0)
    expect(guarded.vx).toBeCloseTo(plain.vx * SKILLS.guard.soften, 5)
    settle(guarded, SKILLS.guard.duration + 0.1)
    expect(guarded.guardLeft).toBe(0)
  })

  it('a contact impulse is capped below the limit the server relays', () => {
    const a = ready()
    a.place(0, 0)
    a.vx = RULES.max_speed * 1.9
    const hits = a.step(1 / 60, [{ seat: 'p2', ball: { x: 1.2, z: 0, vx: -RULES.max_speed * 1.9, vz: 0 } }])
    expect(hits.length).toBe(1)
    expect(Math.hypot(hits[0].jx, hits[0].jz)).toBeLessThanOrEqual(RULES.max_speed * 2)
  })
})

describe('shrinking arena', () => {
  const ball = () => {
    const own = new OwnBall()
    own.configure(RULES)
    return own
  }

  it('the floor holds its size, then shrinks to a minimum', () => {
    expect(floorRadius(10, 0)).toBe(10)
    expect(floorRadius(10, SHRINK.delay)).toBe(10)
    expect(floorRadius(10, SHRINK.delay + 5)).toBeCloseTo(10 - 5 * SHRINK.rate, 5)
    expect(floorRadius(10, 1000)).toBe(SHRINK.minRadius)
  })

  it('a ball standing still on the shrunk part drifts inward and is never put out', () => {
    const own = ball()
    own.place(9, 0)
    for (let t = 0; t < 30; t += 1 / 60) own.step(1 / 60, [], SHRINK.minRadius)
    expect(own.out).toBe(false)
    expect(Math.hypot(own.x, own.z)).toBeLessThan(SHRINK.minRadius + 1)
  })

  it('the pull is weaker than the ball\'s own acceleration, so a ball can still push out against it', () => {
    expect(SHRINK.pull).toBeLessThan(RULES.accel)
    const own = ball()
    own.place(6, 0)
    own.setInput(1, 0)
    for (let t = 0; t < 4; t += 1 / 60) own.step(1 / 60, [], SHRINK.minRadius)
    expect(own.x).toBeGreaterThan(6)
  })

  it('a ball pushed over the real edge is still out', () => {
    const own = ball()
    own.place(9, 0)
    own.vx = 8
    for (let t = 0; t < 1; t += 1 / 60) own.step(1 / 60, [], SHRINK.minRadius)
    expect(own.out).toBe(true)
  })
})

describe('dash ram', () => {
  it('a dashing ball pushes the other harder and keeps more speed than a plain bump', () => {
    const bump = (dash: boolean) => {
      const own = new OwnBall()
      own.configure(RULES)
      own.place(0, 0)
      own.setInput(1, 0)
      for (let t = 0; t < 4; t += 1 / 60) own.step(1 / 60, [])
      own.place(0, 0)
      own.setInput(1, 0)
      own.vx = 6
      if (dash) own.use('dash')
      const before = own.vx
      const hits = own.step(1 / 60, [{ seat: 'p2', ball: { x: 1.6, z: 0, vx: 0, vz: 0 } }])
      return { push: Math.hypot(hits[0]?.jx ?? 0, hits[0]?.jz ?? 0), kept: own.vx / before }
    }
    const plain = bump(false)
    const ram = bump(true)
    expect(ram.push).toBeGreaterThan(plain.push)
    expect(ram.push).toBeLessThanOrEqual(RULES.max_speed * 2)
    expect(ram.kept).toBeGreaterThan(plain.kept)
  })

  it('a ram always pushes at least the minimum', () => {
    const own = new OwnBall()
    own.configure(RULES)
    own.place(0, 0)
    own.setInput(1, 0)
    for (let t = 0; t < 4; t += 1 / 60) own.step(1 / 60, [])
    own.place(0, 0)
    own.vx = 2
    own.use('dash')
    const hits = own.step(1 / 60, [{ seat: 'p2', ball: { x: 1.6, z: 0, vx: 0, vz: 0 } }])
    expect(Math.hypot(hits[0].jx, hits[0].jz)).toBeGreaterThanOrEqual(SKILLS.dash.minPush - 1e-6)
  })
})

describe('charged blast', () => {
  const ready = () => {
    const own = new OwnBall()
    own.configure({ ...RULES, arena_radius: 200 })
    own.place(0, 0)
    for (let t = 0; t < BLAST.firstCooldown + 0.1; t += 1 / 60) own.step(1 / 60, [])
    return own
  }
  const hold = (own: OwnBall, seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) own.step(1 / 60, [])
  }

  it('a longer charge reaches further, pushes harder and recharges slower', () => {
    const tap = blastStats(0)
    const full = blastStats(1)
    expect(full.radius).toBeGreaterThan(tap.radius)
    expect(full.power).toBeGreaterThan(tap.power)
    expect(full.cooldown).toBeGreaterThan(tap.cooldown)
    expect(blastStats(0.5).radius).toBeGreaterThan(tap.radius)
    expect(blastStats(0.5).radius).toBeLessThan(full.radius)
    expect(blastStats(-3)).toEqual(tap)
    expect(blastStats(9)).toEqual(full)
  })

  it('a quick tap is level 0 and the full charge time is level 1', () => {
    expect(chargeLevel(0)).toBe(0)
    expect(chargeLevel(BLAST.minCharge)).toBe(0)
    expect(chargeLevel(BLAST.chargeTime)).toBe(1)
    expect(chargeLevel(BLAST.autoRelease)).toBe(1)
    expect(chargeLevel((BLAST.minCharge + BLAST.chargeTime) / 2)).toBeCloseTo(0.5, 5)
  })

  it('holding charges, releasing fires at that level and sets the matching cooldown', () => {
    const own = ready()
    expect(own.startCharge()).toBe(true)
    expect(own.startCharge()).toBe(false)
    hold(own, BLAST.chargeTime)
    expect(own.charging).toBe(true)
    const shot = own.release()
    expect(shot).not.toBeNull()
    expect(shot!.level).toBe(1)
    expect(own.charging).toBe(false)
    expect(own.cooldown.blast).toBeCloseTo(blastStats(1).cooldown, 5)
    expect(own.blastTotal).toBeCloseTo(blastStats(1).cooldown, 5)
    expect(own.release()).toBeNull()
    expect(own.startCharge()).toBe(false)

    const quick = ready()
    quick.startCharge()
    hold(quick, 0.05)
    expect(quick.release()!.level).toBe(0)
    expect(quick.cooldown.blast).toBeCloseTo(blastStats(0).cooldown, 5)
  })

  it('a charging ball handles slower', () => {
    const free = ready()
    free.setInput(1, 0)
    hold(free, 0.4)
    const charging = ready()
    charging.startCharge()
    charging.setInput(1, 0)
    hold(charging, 0.4)
    expect(charging.vx).toBeGreaterThan(0)
    expect(charging.vx).toBeLessThan(free.vx * 0.75)
  })

  it('a hit or a blast breaks the charge, a guard protects it, a dash gives it up', () => {
    const hit = ready()
    hit.startCharge()
    hold(hit, 0.5)
    hit.receiveHit('p2', BLAST.interruptImpulse + 1, 0)
    expect(hit.charging).toBe(false)
    expect(hit.takeBroken()).toBe(true)
    expect(hit.takeBroken()).toBe(false)
    expect(hit.cooldown.blast).toBeGreaterThanOrEqual(BLAST.interruptCooldown - 1e-6)

    const light = ready()
    light.startCharge()
    light.receiveHit('p2', BLAST.interruptImpulse - 1, 0)
    expect(light.charging).toBe(true)

    const blasted = ready()
    blasted.place(1, 0)
    for (let t = 0; t < BLAST.firstCooldown + 0.1; t += 1 / 60) blasted.step(1 / 60, [])
    blasted.startCharge()
    blasted.receiveBlast(0, 0, 0.3)
    expect(blasted.charging).toBe(false)

    const guarded = ready()
    guarded.startCharge()
    guarded.use('guard')
    guarded.receiveHit('p2', BLAST.interruptImpulse + 3, 0)
    expect(guarded.charging).toBe(true)

    const dasher = ready()
    dasher.startCharge()
    dasher.setInput(1, 0)
    dasher.use('dash')
    expect(dasher.charging).toBe(false)
  })

  it('a blast at the pierce level breaks a guard, a weaker one is softened', () => {
    const weak = ready()
    weak.place(1, 0)
    weak.use('guard')
    weak.receiveBlast(0, 0, 0.5)
    const open = ready()
    open.place(1, 0)
    open.receiveBlast(0, 0, 0.5)
    expect(weak.vx).toBeCloseTo(open.vx * SKILLS.guard.soften, 5)
    expect(weak.guardLeft).toBeGreaterThan(0)

    const strong = ready()
    strong.place(1, 0)
    strong.use('guard')
    strong.receiveBlast(0, 0, 1)
    const unguarded = ready()
    unguarded.place(1, 0)
    unguarded.receiveBlast(0, 0, 1)
    expect(strong.vx).toBeCloseTo(unguarded.vx, 5)
    expect(strong.guardLeft).toBe(0)
  })

  it('the radius and power of a received blast follow its level', () => {
    const reach = (level: number, distance: number) => {
      const own = ready()
      own.place(distance, 0)
      return own.receiveBlast(0, 0, level)
    }
    expect(reach(0, blastStats(0).radius + 0.3)).toBe(0)
    expect(reach(1, blastStats(0).radius + 0.3)).toBeGreaterThan(0)
    expect(reach(1, blastStats(1).radius + 0.3)).toBe(0)
    const small = ready()
    small.place(1, 0)
    small.receiveBlast(0, 0, 0)
    const big = ready()
    big.place(1, 0)
    big.receiveBlast(0, 0, 1)
    expect(big.vx).toBeGreaterThan(small.vx)
    expect(Math.hypot(big.vx, big.vz)).toBeLessThanOrEqual(RULES.max_speed * 1.9)
  })
})
