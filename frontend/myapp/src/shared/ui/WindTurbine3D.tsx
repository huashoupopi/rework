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

        const width = host.clientWidth || 280
        const height = host.clientHeight || 280
        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 40)
        camera.position.set(3.4, 1.7, 5.4)
        camera.lookAt(0, 1.15, 0)

        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        renderer.setSize(width, height)
        host.appendChild(renderer.domElement)

        const metal = new THREE.MeshStandardMaterial({ color: 0xb7c7db, metalness: 0.35, roughness: 0.45 })
        const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 2.3, 12), metal)
        tower.position.y = 0.05
        const nacelle = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.22, 0.22), metal)
        nacelle.position.set(0.1, 1.24, 0)

        const hub = new THREE.Group()
        hub.position.set(0.32, 1.24, 0)
        const bladeGeometry = new THREE.CylinderGeometry(0.016, 0.072, 1.32, 8)
        bladeGeometry.translate(0, 0.66, 0)
        bladeGeometry.scale(1, 1, 0.32)
        const bladeMaterial = new THREE.MeshStandardMaterial({ color: 0x4d8dff, metalness: 0.2, roughness: 0.35 })
        for (let index = 0; index < 3; index += 1) {
          const blade = new THREE.Mesh(bladeGeometry, bladeMaterial)
          blade.rotation.z = (index * Math.PI * 2) / 3
          hub.add(blade)
        }
        hub.add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), metal))

        const key = new THREE.DirectionalLight(0xffffff, 1.15)
        key.position.set(3, 5, 4)
        scene.add(new THREE.AmbientLight(0x6d88aa, 0.55), key, tower, nacelle, hub)

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
            hub.rotation.z += delta * (flags.boost ? 11 : 2.6)
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
