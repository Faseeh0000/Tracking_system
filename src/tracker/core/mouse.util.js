import { getLogger } from './logger.js';

const log = getLogger().tag('IdleMouse');

/**
 * Starts gentle, human-like background cursor and scroll activity on a Playwright page.
 * Leverages Camoufox's native `humanize` engine to generate smooth, non-linear Bézier curves.
 *
 * @param {import('playwright').Page} page - The Playwright/Camoufox page instance
 * @param {Object} [options]
 * @param {number} [options.minInterval=1000] - Minimum delay between movements in ms
 * @param {number} [options.maxInterval=2500] - Maximum delay between movements in ms
 * @param {boolean} [options.enableScroll=true] - Whether to include occasional subtle mouse wheel scrolls
 * @returns {() => void} stop - Call this function to gracefully stop the background loop
 */
export function startIdleMouse(page, options = {}) {
    if (!page || typeof page.mouse?.move !== 'function') {
        return () => {};
    }

    const {
        minInterval = 1000,
        maxInterval = 2500,
        enableScroll = true
    } = options;

    let active = true;
    let isMoving = false;

    const stop = () => {
        active = false;
    };

    (async () => {
        // Brief initial delay so initial document load can establish
        await new Promise(r => setTimeout(r, 600));

        while (active && !page.isClosed()) {
            try {
                if (page.isClosed()) break;

                const viewport = page.viewportSize() || { width: 1280, height: 800 };
                const padX = Math.floor(viewport.width * 0.12);
                const padY = Math.floor(viewport.height * 0.15);

                const targetX = Math.floor(padX + Math.random() * (viewport.width - padX * 2));
                const targetY = Math.floor(padY + Math.random() * (viewport.height - padY * 2));

                isMoving = true;
                // Camoufox's internal humanize handles natural Bézier velocity & jitter
                await page.mouse.move(targetX, targetY);
                isMoving = false;

                // 25% chance of subtle human scroll
                if (enableScroll && Math.random() < 0.25 && !page.isClosed()) {
                    const scrollAmount = (Math.random() > 0.3 ? 1 : -1) * Math.floor(40 + Math.random() * 80);
                    await page.mouse.wheel(0, scrollAmount);
                }
            } catch (_) {
                // Ignore navigation or context-close races
                isMoving = false;
            }

            // Variable delay between idle actions
            const delay = minInterval + Math.random() * (maxInterval - minInterval);
            await new Promise(r => setTimeout(r, delay));
        }
    })();

    // Attach stop helper directly to the page for convenience
    page.stopIdleMouse = stop;
    return stop;
}

export default startIdleMouse;
