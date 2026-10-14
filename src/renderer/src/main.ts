const divider = document.getElementById('divider')!
let split = 0.26
let dragging = false

// Height of the shell titlebar strip (traffic lights + app name) — the surface
// views are laid out below it so feed content can't slide under the lights.
const TITLEBAR = 38

function report(): void {
  const { innerWidth: w, innerHeight: h } = window
  const x = Math.round(w * split)
  divider.style.left = `${x - 2}px`
  window.taskdeck.sendRegions({
    feed: { x: 0, y: TITLEBAR, width: x - 2, height: h - TITLEBAR },
    board: { x: x + 2, y: TITLEBAR, width: w - x - 2, height: h - TITLEBAR }
  })
}
divider.addEventListener('mousedown', () => (dragging = true))
window.addEventListener('mouseup', () => (dragging = false))
window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  split = Math.min(0.8, Math.max(0.18, e.clientX / window.innerWidth))
  report()
})
window.addEventListener('resize', report)
report()
