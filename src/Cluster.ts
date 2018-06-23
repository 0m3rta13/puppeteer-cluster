
import Job, { JobData } from './Job';
import Display from './Display';
import * as util from './util';
import Worker, { TaskArguments } from './Worker';

import ConcurrencyBrowser from './browser/ConcurrencyBrowser';
import ConcurrencyPage from './browser/ConcurrencyPage';
import ConcurrencyContext from './browser/ConcurrencyContext';

import { LaunchOptions, Page } from 'puppeteer';
import AbstractBrowser from './browser/AbstractBrowser';
import Queue from './Queue';

const debug = util.debugGenerator('Cluster');

// TODO find out how we can combine options and optionsargument
interface ClusterOptionsArgument {
    maxConcurrency?: number;
    maxCPU?: number;
    maxMemory?: number;
    concurrency?: number;
    puppeteerOptions?: LaunchOptions;
    monitor?: boolean;
    timeout?: number;
    retryLimit?: number;
    retryDelay?: number;
    skipDuplicateUrls?: boolean;
    sameDomainDelay?: number;
}

interface ClusterOptions extends ClusterOptionsArgument {
    maxConcurrency: number;
    maxCPU: number;
    maxMemory: number;
    concurrency: number;
    puppeteerOptions: LaunchOptions;
    monitor: boolean;
    timeout: number;
    retryLimit: number;
    retryDelay: number;
    skipDuplicateUrls: boolean;
    sameDomainDelay: number;
}

const DEFAULT_OPTIONS: ClusterOptions = {
    maxConcurrency: 1,
    maxCPU: 1,
    maxMemory: 1,
    concurrency: 2, // PAGE
    puppeteerOptions: {
        headless: false, // just for testing...
    },
    monitor: false,
    timeout: 30 * 1000,
    retryLimit: 0,
    retryDelay: 0,
    skipDuplicateUrls: false,
    sameDomainDelay: 0,
};

export interface QueueOptions {
    priority?: number;
    task?: string;
}

export type TaskFunction =
    (url: string | JobData, page: Page, options: TaskArguments) => Promise<void>;

const MONITORING_INTERVAL = 500;

export default class Cluster {

    static CONCURRENCY_PAGE = 1; // shares cookies, etc.
    static CONCURRENCY_CONTEXT = 2; // no cookie sharing (uses contexts)
    static CONCURRENCY_BROWSER = 3; // no cookie sharing and individual processes (uses contexts)

    private options: ClusterOptions;
    private workers: Worker[] = [];
    private workersAvail: Worker[] = [];
    private workersBusy: Worker[] = [];
    private workersStarting = 0;

    private allTargetCount = 0;
    private jobQueue: Queue<Job> = new Queue<Job>();

    private taskFunction: TaskFunction | null = null;
    private idleResolvers: (() => void)[] = [];
    private waitForOneResolvers: (() => void)[] = [];
    private browser: AbstractBrowser | null = null;

    private isClosed = false;
    private startTime = Date.now();
    private nextWorkerId = -1;

    private monitoringInterval: NodeJS.Timer | null = null;
    private display: Display | null = null;

    private duplicateCheckUrls: Set<string> = new Set();
    private lastDomainAccesses: Map<string, number> = new Map();

    public static async launch(options: ClusterOptionsArgument) {
        debug('Launching');
        const cluster = new Cluster(options);
        await cluster.init();

        return cluster;
    }

    private constructor(options: ClusterOptionsArgument) {
        this.options = {
            ...DEFAULT_OPTIONS,
            ...options,
        };

        if (this.options.monitor) {
            this.monitoringInterval = setInterval(
                () => this.monitor(),
                MONITORING_INTERVAL,
            );
        }

        this.jobQueue.on('delayed-job-inserted-empty-before', () => {
            // queue goes from empty to at least one element
            this.work();
        });
    }

    private async init() {
        const browserOptions = this.options.puppeteerOptions;

        if (this.options.concurrency === Cluster.CONCURRENCY_PAGE) {
            this.browser = new ConcurrencyPage(browserOptions);
        } else if (this.options.concurrency === Cluster.CONCURRENCY_CONTEXT) {
            this.browser = new ConcurrencyContext(browserOptions);
        } else if (this.options.concurrency === Cluster.CONCURRENCY_BROWSER) {
            this.browser = new ConcurrencyBrowser(browserOptions);
        } else {
            throw new Error('Unknown concurrency option: ' + this.options.concurrency);
        }

        try {
            await this.browser.init();
        } catch (err) {
            throw new Error(`Unable to launch browser, error message: ${err.message}`);
        }
    }

    private async launchWorker() {
        // signal, that we are starting a worker
        this.workersStarting += 1;
        this.nextWorkerId += 1;

        const workerId = this.nextWorkerId;

        let workerBrowserInstance;
        try {
            workerBrowserInstance = await (this.browser as AbstractBrowser).workerInstance();
        } catch (err) {
            throw new Error(`Unable to launch browser for worker, error message: ${err.message}`);
        }

        const worker = new Worker({
            cluster: this,
            args: [''], // this.options.args,
            browser: workerBrowserInstance,
            id: workerId,
        });
        this.workersStarting -= 1;

        if (this.isClosed) {
            // cluster was closed while we created a new worker (should rarely happen)
            worker.close();
        } else {
            this.workersAvail.push(worker);
            this.workers.push(worker);
        }
    }

    public async task(taskFunction: TaskFunction) {
        this.taskFunction = taskFunction;
        // TODO handle different names for tasks
    }

    private calledForWork: boolean = false;

    // check for new work soon (wait if there will be put more data into the queue, first)
    private async work() {
        // make sure, there is only one setImmediate call waiting
        if (!this.calledForWork) {
            this.calledForWork = true;
            setImmediate(() => this.doWork());
        }
    }

    private async doWork() {
        this.calledForWork = false;

        if (this.taskFunction === null) {
            throw new Error('No task defined!');
        }

        // no jobs available
        if (this.jobQueue.size() === 0) {
            if (this.workersBusy.length === 0) {
                this.idleResolvers.forEach(resolve => resolve());
            }
            return;
        }

        // no workers available
        if (this.workersAvail.length === 0) {
            if (this.allowedToStartWorker()) {
                await this.launchWorker();
                this.work();
            }
            return;
        }

        const job = this.jobQueue.shift();

        if (job === undefined) {
            // skip, there are items in the queue but they are all delayed
            this.work();
            return;
        }

        const url = job.getUrl();
        const domain = job.getDomain();

        if (this.options.skipDuplicateUrls
            && url !== undefined && this.duplicateCheckUrls.has(url)) {
            // already crawled, just ignore
            debug('Skipping duplicate URL: ' + job.getUrl());
            this.work();
            return;
        }

        if (this.options.sameDomainDelay !== 0 && domain !== undefined) {
            const lastDomainAccess = this.lastDomainAccesses.get(domain);
            if (lastDomainAccess !== undefined
                && lastDomainAccess + this.options.sameDomainDelay < Date.now()) {
                this.jobQueue.push(job, {
                    delayUntil: lastDomainAccess + this.options.sameDomainDelay,
                });
            }
        }

        // worker is available, lets go
        const worker = <Worker>this.workersAvail.shift();
        this.workersBusy.push(worker);

        if (this.workersAvail.length !== 0) {
            // we can execute more work in parallel
            this.work();
        }

        const resultError: Error | null = await worker.handle(
            this.taskFunction,
            job,
            this.options.timeout,
        );

        if (resultError === null) {
            if (this.options.skipDuplicateUrls && url !== undefined) {
                this.duplicateCheckUrls.add(url);
            }
            if (this.options.sameDomainDelay !== 0 && domain !== undefined) {
                this.lastDomainAccesses.set(domain, Date.now());
            }
        } else { // error during execution
            // error during execution
            job.addError(resultError);
            if (job.tries <= this.options.retryLimit) {
                let delayUntil = undefined;
                if (this.options.retryDelay) {
                    delayUntil = Date.now() + this.options.retryDelay;
                }
                this.jobQueue.push(job, {
                    delayUntil,
                });
            }
        }
        this.waitForOneResolvers.forEach(resolve => resolve());

        // add worker to available workers again
        const workerIndex = this.workersBusy.indexOf(worker);
        this.workersBusy.splice(workerIndex, 1);

        this.workersAvail.push(worker);

        this.work();
    }

    private allowedToStartWorker(): boolean {
        const workerCount = this.workers.length + this.workersStarting;
        return (workerCount < this.options.maxConcurrency);
    }

    // TODO implement all queue options
    public async queue(url: string | JobData, options: QueueOptions = {}) {
        this.allTargetCount += 1;
        this.jobQueue.push(new Job(url));
        this.work();
    }

    public idle(): Promise<void> {
        return new Promise(resolve => this.idleResolvers.push(resolve));
    }

    public waitForOne(): Promise<void> {
        return new Promise(resolve => this.waitForOneResolvers.push(resolve));
    }

    public async close(): Promise<void> {
        this.isClosed = true;

        // close workers
        await Promise.all(this.workers.map(worker => worker.close()));

        try {
            await (this.browser as AbstractBrowser).close();
        } catch (err) {
            debug(`Error: Unable to close browser, message: ${err.message}`);
        }

        if (this.monitoringInterval) {
            this.monitor();
            clearInterval(this.monitoringInterval);
        }

        if (this.display) {
            this.display.close();
        }
        debug('Closed');
    }

    private monitor(): void {
        if (!this.display) {
            this.display = new Display();
        }
        const display = this.display;

        const now = Date.now();
        const timeDiff = now - this.startTime;

        const doneTargets = this.allTargetCount - this.jobQueue.size() - this.workersBusy.length;
        const donePercentage = (doneTargets / this.allTargetCount);
        const donePercStr = (100 * donePercentage).toFixed(2);

        const timeRunning = util.formatDuration(timeDiff);

        let timeRemainingMillis = -1;
        if (donePercentage !== 0) {
            timeRemainingMillis = ((timeDiff) / donePercentage) - timeDiff;
        }
        const timeRemining = util.formatDuration(timeRemainingMillis);

        display.log(`== Start:     ${util.formatDateTime(this.startTime)}`);
        display.log(`== Now:       ${util.formatDateTime(now)} (running for ${timeRunning})`);
        display.log(`== Progress:  ${doneTargets} / ${this.allTargetCount} (${donePercStr}%)`);
        display.log(`== Remaining: ${timeRemining} (rough estimation)`);
        display.log(`== Workers:   ${this.workers.length + this.workersStarting}`);

        this.workers.forEach((worker, i) => {
            const isIdle = this.workersAvail.indexOf(worker) !== -1;
            let workOrIdle;
            let workerUrl = '';
            if (isIdle) {
                workOrIdle = 'IDLE';
            } else {
                workOrIdle = 'WORK';
                if (worker.activeTarget) {
                    workerUrl = worker.activeTarget.getUrl() || 'UNKNOWN TARGET';
                } else {
                    workerUrl = 'NO TARGET (should not be happening)';
                }
            }

            display.log(`   #${i} ${workOrIdle} ${workerUrl}`);
        });
        for (let i = 0; i < this.workersStarting; i += 1) {
            display.log(`   #${this.workers.length + i} STARTING...`);
        }

        display.resetCursor();
    }

}
