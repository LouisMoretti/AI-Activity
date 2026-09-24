// Shared "now" (epoch seconds) so countdowns and "x ago" labels stay fresh
// between data refreshes without each component running its own timer.
export const clock = $state({ now: Math.floor(Date.now() / 1000) });

setInterval(() => { clock.now = Math.floor(Date.now() / 1000); }, 15000);
