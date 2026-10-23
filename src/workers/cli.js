import '../config/env.js';
import { initialize, track, trackBatch, shutdown } from '../tracker/index.js';

async function main() {
    const args = process.argv.slice(2);
    if (!args.length) {
        console.log('Usage: node cli.js <tracking_number_1> [tracking_number_2 ...] [--carrier fedex|ups|usps]');
        process.exit(1);
    }

    let carrier = null;
    const trackingNumbers = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--carrier' && args[i + 1]) {
            carrier = args[i + 1];
            i++;
        } else {
            const split = args[i].split(',').map(s => s.trim()).filter(Boolean);
            trackingNumbers.push(...split);
        }
    }

    console.log(`[CLI] 🔍 Tracking ${trackingNumbers.length} shipment(s)...`);

    try {
        const headlessEnv = process.env.HEADLESS ? String(process.env.HEADLESS).trim().toLowerCase() : '';
        const headless = headlessEnv === 'virtual' ? 'virtual' : (headlessEnv === 'true' || headlessEnv === '1');

        await initialize({
            headless,
            proxy: process.env.PROXY || undefined,
            uspsProxy: process.env.USPS_PROXY || undefined,
            httpProxy: process.env.HTTP_PROXY || undefined,
            maxTrackingRetries: process.env.MAX_TRACKING_RETRIES ? Number(process.env.MAX_TRACKING_RETRIES) : undefined,
        });

        if (trackingNumbers.length === 1) {
            const result = await track(trackingNumbers[0], carrier);
            console.log('\nResult:\n', JSON.stringify(result, null, 2));
        } else {
            const results = await trackBatch(trackingNumbers, carrier);
            console.log('\nResults:\n', JSON.stringify(results, null, 2));
        }
    } catch (err) {
        console.error(`[CLI] ❌ Tracking Error: ${err.message}`);
    } finally {
        await shutdown();
    }
}

main().catch(err => {
    console.error('[CLI] Fatal Error:', err);
    process.exit(1);
});
