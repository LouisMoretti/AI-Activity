// Shared "now" (epoch seconds) so countdowns and "x ago" labels stay fresh
// between data refreshes without each component running its own timer.
export const clock = $state({ now: Math.floor(Date.now() / 1000) });

const tick = () => { if (!document.hidden) clock.now = Math.floor(Date.now() / 1000); };
let id: ReturnType<typeof setInterval> | undefined;
const startPolling = () => {
  if (!document.hidden && id === undefined) id = setInterval(tick, 5000);
};

startPolling();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (id !== undefined) clearInterval(id);
    id = undefined;
  } else {
    tick();
    startPolling();
  }
});
