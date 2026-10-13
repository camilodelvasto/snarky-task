const divider = document.getElementById('divider')!
let split = 0.26
let dragging = false

function report(): void {
  const { innerWidth: w, innerHeight: h } = window
  const x = Math.round(w * split)
  divider.style.left = `${x - 2}px`
  window.taskdeck.sendRegions({
    feed: { x: 0, y: 0, width: x - 2, height: h },
    board: { x: x + 2, y: 0, width: w - x - 2, height: h }
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
