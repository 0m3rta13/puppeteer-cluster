const { Cluster } = require('../dist');

(async () => {
    const cluster = await Cluster.launch({
        concurrency: Cluster.CONCURRENCY_CONTEXT,
        maxConcurrency: 2,
    });

    await cluster.task(async (page, url) => {
        await page.goto(url);

        const pageTitle = await page.evaluate(() => document.title);
        console.log(`Page title of ${url} is ${pageTitle}`);
    });

    await cluster.queue('http://www.google.com');
    await cluster.queue('http://www.wikipedia.org');
    await cluster.queue('https://github.com/GoogleChrome/puppeteer/blob/v1.5.0/docs/api.md');
    await cluster.queue(async (page) => {
        // We can also queue functions
        console.log('Just like this.');
    });

    await cluster.idle();
    await cluster.close();
})();