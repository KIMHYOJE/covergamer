import * as THREE from 'three'

type Particle = { life: number; max: number; pos: THREE.Vector3; vel: THREE.Vector3; size: number; color: THREE.Color; gravity: number }

const MAX = 900
const RING_POOL = 10

type Ring = { mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; life: number; max: number; radius: number }

/**
 * Pooled particle bursts on one InstancedMesh (a single draw call for every effect).
 * Use `burst()` for pickups/hits and `puff()` for dust.
 */
export class Effects {
  readonly mesh: THREE.InstancedMesh
  /** Expanding shockwave rings (blasts, hard bumps, ring-outs); add this group to the scene too. */
  readonly rings = new THREE.Group()
  private readonly ringPool: Ring[] = []
  private particles: Particle[] = []
  private readonly dummy = new THREE.Object3D()

  constructor() {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false })
    this.mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.12, 0), mat, MAX)
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.setColorAt(0, new THREE.Color())
    const geometry = new THREE.RingGeometry(0.9, 1, 64)
    for (let i = 0; i < RING_POOL; i += 1) {
      const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.rotation.x = -Math.PI / 2
      mesh.position.y = 0.07
      mesh.visible = false
      this.rings.add(mesh)
      this.ringPool.push({ mesh, life: 0, max: 1, radius: 1 })
    }
  }

  /** A ring that expands from `x`, `z` to `radius` metres and fades. */
  shockwave(x: number, z: number, color: THREE.ColorRepresentation, radius: number, duration = 0.55): void {
    const ring = this.ringPool.find(r => !r.mesh.visible) ?? this.ringPool.reduce((a, b) => (a.life / a.max > b.life / b.max ? a : b))
    ring.life = 0
    ring.max = duration
    ring.radius = radius
    ring.mesh.visible = true
    ring.mesh.position.x = x
    ring.mesh.position.z = z
    ring.mesh.material.color.set(color)
  }

  /** A short-lived glowing speck left behind a fast ball. */
  trail(at: THREE.Vector3, color: THREE.ColorRepresentation, size = 1): void {
    const vel = new THREE.Vector3((Math.random() - 0.5) * 0.8, Math.random() * 0.6, (Math.random() - 0.5) * 0.8)
    this.spawn({ life: 0, max: 0.28 + Math.random() * 0.14, pos: at.clone(), vel, size: size * (0.9 + Math.random() * 0.5), color: new THREE.Color(color), gravity: 0 })
  }

  /** A ring of fast particles flung outward along the floor (blast). */
  radial(at: THREE.Vector3, color: THREE.ColorRepresentation, count = 40, speed = 11): void {
    const c = new THREE.Color(color)
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.2
      const vel = new THREE.Vector3(Math.cos(a), 0.08 + Math.random() * 0.25, Math.sin(a)).multiplyScalar(speed * (0.55 + Math.random() * 0.45))
      this.spawn({ life: 0, max: 0.45 + Math.random() * 0.3, pos: at.clone(), vel, size: 1.1 + Math.random() * 1.1, color: c, gravity: -3 })
    }
  }

  burst(at: THREE.Vector3, color: THREE.ColorRepresentation, count = 24, speed = 6): void {
    const c = new THREE.Color(color)
    for (let i = 0; i < count; i += 1) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize()
      this.spawn({ life: 0, max: 0.5 + Math.random() * 0.4, pos: at.clone(), vel: dir.multiplyScalar(speed * (0.4 + Math.random() * 0.6)), size: 0.8 + Math.random() * 0.8, color: c, gravity: -12 })
    }
  }

  puff(at: THREE.Vector3, strength = 1): void {
    const c = new THREE.Color('#f3e6cf')
    const n = Math.round(8 + strength * 10)
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2
      const vel = new THREE.Vector3(Math.cos(a), 0.25 + Math.random() * 0.3, Math.sin(a)).multiplyScalar(2 + strength * 3)
      this.spawn({ life: 0, max: 0.35 + Math.random() * 0.25, pos: at.clone(), vel, size: 1.2 + Math.random(), color: c, gravity: -2 })
    }
  }

  private spawn(p: Particle): void {
    if (this.particles.length >= MAX) this.particles.shift()
    this.particles.push(p)
  }

  update(dt: number): void {
    for (const ring of this.ringPool) {
      if (!ring.mesh.visible) continue
      ring.life += dt
      const k = ring.life / ring.max
      if (k >= 1) { ring.mesh.visible = false; continue }
      ring.mesh.scale.setScalar(Math.max(0.01, ring.radius * (1 - (1 - k) ** 3)))
      ring.mesh.material.opacity = (1 - k) ** 1.4
    }
    this.particles = this.particles.filter(p => (p.life += dt) < p.max)
    this.particles.forEach((p, i) => {
      p.vel.y += p.gravity * dt
      p.vel.multiplyScalar(1 - 2.2 * dt)
      p.pos.addScaledVector(p.vel, dt)
      const k = 1 - p.life / p.max
      this.dummy.position.copy(p.pos)
      this.dummy.scale.setScalar(p.size * k)
      this.dummy.rotation.set(p.life * 6, p.life * 4, 0)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
      this.mesh.setColorAt(i, p.color)
    })
    this.mesh.count = this.particles.length
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  clear(): void {
    for (const ring of this.ringPool) ring.mesh.visible = false
    this.particles = []
    this.mesh.count = 0
  }
}
