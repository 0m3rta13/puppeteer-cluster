
import Job, { JobData } from './Job';
import Cluster, { TaskFunction } from './Cluster';
import { WorkerBrowserInstance, ContextInstance } from './browser/AbstractBrowser';
import { Page } from 'puppeteer';
import { timeoutExecute, debugGenerator, log } from './util';

const debug = debugGenerator('Worker');

const DEFAULT_OPTIONS = {
    args: [],
};

interface WorkerOptions {
    cluster: Cluster;
    args: string[];
    id: number;
    browser: WorkerBrowserInstance;
}

export interface TaskArguments {
    worker: {
        id: number;
    };
}

const BROWSER_TIMEOUT = 5000;

export default class Worker implements WorkerOptions {

    cluster: Cluster;
    args: string[];
    id: number;
    browser: WorkerBrowserInstance;

    activeTarget: Job | null = null;

    public constructor({ cluster, args, id, browser }: WorkerOptions) {
        this.cluster = cluster;
        this.args = args;
        this.id = id;
        this.browser = browser;

        debug(`Starting #${this.id}`);
    }

    public async handle(
            task: TaskFunction,
            job: Job,
            timeout: number,
        ): Promise<Error | null> {
        this.activeTarget = job;

        let browserInstance: ContextInstance | null = null;
        let page: Page | null = null;

        try {
            browserInstance = await timeoutExecute(BROWSER_TIMEOUT, this.browser.instance());
            page = browserInstance.page;
        } catch (err) {
            debug('Error getting browser page: ' + err.message);
            await this.browser.repair();
            // TODO log how often this does not work to escalte when it happens to often?
            return err;
        }

        let errorState: Error | null = null;

        try {
            await timeoutExecute(
                timeout,
                task(job.url, page, {
                    worker: { id: this.id },
                }),
            );
        } catch (err) {
            errorState = err;
            log('Error crawling ' + job.url + ' // message: ' + err.message);
        }

        try {
            await timeoutExecute(BROWSER_TIMEOUT, browserInstance.close());
        } catch (e) {
            debug('Error closing browser instance for ' + job.url + ': ' + e.message);
            await this.browser.repair();
        }

        this.activeTarget = null;

        return errorState;
    }

    public async close(): Promise<void> {
        try {
            await this.browser.close();
        } catch (err) {
            debug(`Unable to close worker browser. Error message: ${err.message}`);
        }
        debug(`Closed #${this.id}`);
    }

}
