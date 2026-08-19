import * as React from "react"
import { useReducedMotion } from "motion/react"

import { WindTurbineSvg } from "./WindTurbineSvg"

type WindTurbine3DProps = {
  boost?: boolean
  spinning?: boolean
  stopped?: boolean
}

function canUseWebGL() {
  try {
    const canvas = document.createElement("canvas")
    return Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
  } catch {
    return false
  }
}

export function WindTurbine3D({ boost = false, spinning = true, stopped = false }: WindTurbine3DProps) {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  const flagsRef = React.useRef({ boost, spinning, stopped })
  const [fallback, setFallback] = React.useState(() => !canUseWebGL())

  flagsRef.current = {
    boost: boost && !reduceMotion,
    spinning: spinning && !reduceMotion,
    stopped: stopped || Boolean(reduceMotion),
  }

  React.useEffect(() => {
    if (fallback) {
      return
    }

    const host = hostRef.current
    if (!host) {
      return
    }

    let disposed = false
    let cleanup = () => {}

    const start = async () => {
      try {
        const THREE = await import("three")
        if (disposed || !hostRef.current) {
          return
        }

        const width = host.clientWidth || 520
        const height = host.clientHeight || 520
        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 40)
        camera.position.set(3.8, 1.05, 6.1)
        camera.lookAt(0, 0.55, 0)

        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        renderer.setSize(width, height)
        host.appendChild(renderer.domElement)

        const metal = new THREE.MeshStandardMaterial({
          color: 0xa8b8cc,
          emissive: 0x24344c,
          emissiveIntensity: 0.28,
          metalness: 0.52,
          roughness: 0.4,
        })
        const bladeMetal = new THREE.MeshStandardMaterial({
          color: 0xb4c4d6,
          emissive: 0x1c2b40,
          emissiveIntensity: 0.22,
          metalness: 0.48,
          roughness: 0.44,
        })
        const edge = new THREE.LineBasicMaterial({ color: 0xd5e3f2, opacity: 0.7, transparent: true })
        const addRim = (mesh: THREE.Mesh) => {
          mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 22), edge))
        }

        const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.24, 2.55, 16), metal)
        tower.position.y = 0.08
        addRim(tower)
        const nacelle = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.26, 0.26), metal)
        nacelle.position.set(0.12, 1.38, 0)
        addRim(nacelle)

        const hub = new THREE.Group()
        hub.position.set(0.4, 1.38, 0)
        const bladeGeometry = new THREE.CylinderGeometry(0.018, 0.08, 1.28, 8)
        bladeGeometry.translate(0, 0.64, 0)
        bladeGeometry.scale(1, 1, 0.28)
        for (let index = 0; index < 3; index += 1) {
          const blade = new THREE.Mesh(bladeGeometry, bladeMetal)
          blade.rotation.z = (index * Math.PI * 2) / 3
          addRim(blade)
          hub.add(blade)
        }
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 14), metal)
        addRim(cap)
        hub.add(cap)

        const key = new THREE.DirectionalLight(0xf2f6fb, 1.55)
        key.position.set(3.2, 4.6, 3.4)
        const fill = new THREE.DirectionalLight(0xc5d4e6, 0.7)
        fill.position.set(-1.2, 2.4, 4.2)
        const rimLight = new THREE.DirectionalLight(0xcfe0f2, 0.95)
        rimLight.position.set(-3.2, 1.6, -2.4)
        const rig = new THREE.Group()
        rig.add(tower, nacelle, hub)
        rig.scale.setScalar(0.82)
        rig.position.y = 0.12
        scene.add(new THREE.AmbientLight(0x8a9bb0, 0.78), key, fill, rimLight, rig)

        const resize = () => {
          if (!hostRef.current) {
            return
          }
          const nextWidth = hostRef.current.clientWidth || width
          const nextHeight = hostRef.current.clientHeight || height
          camera.aspect = nextWidth / nextHeight
          camera.updateProjectionMatrix()
          renderer.setSize(nextWidth, nextHeight)
        }
        window.addEventListener("resize", resize)

        let frame = 0
        let last = performance.now()
        const tick = (now: number) => {
          frame = 0
          if (document.visibilityState === "hidden") {
            return
          }
          const delta = (now - last) / 1000
          last = now
          const flags = flagsRef.current
          if (flags.spinning && !flags.stopped) {
            hub.rotation.z += delta * (flags.boost ? 4.2 : 0.7)
          }
          renderer.render(scene, camera)
          frame = requestAnimationFrame(tick)
        }

        const onVisibility = () => {
          if (document.visibilityState === "visible") {
            last = performance.now()
            if (!frame) {
              frame = requestAnimationFrame(tick)
            }
            return
          }
          if (frame) {
            cancelAnimationFrame(frame)
            frame = 0
          }
        }
        document.addEventListener("visibilitychange", onVisibility)
        frame = requestAnimationFrame(tick)

        cleanup = () => {
          cancelAnimationFrame(frame)
          window.removeEventListener("resize", resize)
          document.removeEventListener("visibilitychange", onVisibility)
          renderer.dispose()
          if (renderer.domElement.parentNode === host) {
            host.removeChild(renderer.domElement)
          }
        }
      } catch {
        if (!disposed) {
          setFallback(true)
        }
      }
    }

    void start()

    return () => {
      disposed = true
      cleanup()
    }
  }, [fallback])

  if (fallback) {
    return <WindTurbineSvg boost={boost} spinning={spinning} stopped={stopped} />
  }

  return <div aria-hidden className="wind-turbine-3d" ref={hostRef} />
}
