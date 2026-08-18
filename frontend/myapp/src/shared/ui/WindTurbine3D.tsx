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
        const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 40)
        camera.position.set(2.15, 1.25, 3.35)
        camera.lookAt(0, 1.05, 0)

        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        renderer.setSize(width, height)
        host.appendChild(renderer.domElement)

        const metal = new THREE.MeshStandardMaterial({
          color: 0x8596ab,
          emissive: 0x182233,
          emissiveIntensity: 0.2,
          metalness: 0.7,
          roughness: 0.36,
        })
        const bladeMetal = new THREE.MeshStandardMaterial({
          color: 0x8ea0b4,
          emissive: 0x151e2d,
          emissiveIntensity: 0.16,
          metalness: 0.66,
          roughness: 0.4,
        })
        const edge = new THREE.LineBasicMaterial({ color: 0xb4c6da, opacity: 0.42, transparent: true })
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
        const bladeGeometry = new THREE.CylinderGeometry(0.018, 0.08, 1.55, 8)
        bladeGeometry.translate(0, 0.78, 0)
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

        const key = new THREE.DirectionalLight(0xe4edf7, 1.25)
        key.position.set(3.2, 4.6, 3.4)
        const rimLight = new THREE.DirectionalLight(0x9db6d2, 0.55)
        rimLight.position.set(-2.8, 1.8, -2.2)
        scene.add(new THREE.AmbientLight(0x6d7f96, 0.55), key, rimLight, tower, nacelle, hub)

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
