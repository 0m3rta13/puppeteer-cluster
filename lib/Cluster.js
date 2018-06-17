
const Worker = require('./Worker');
const Target = require('./Target');
const Browser = require('./Browser');
const Display = require('./Display');
const constants = require('./constants');

const DEFAULT_OPTIONS = {
    minWorker: 0,
    maxWorker: 4,
    maxCPU: 1,
    maxMemory: 1,
    concurrency: constants.CLUSTER_CONCURRENCY_PAGE,
    args: [],
    monitor: false,
};

class Cluster {

    static async launch(options) {
        const cluster = new Cluster(options);
        await cluster.init();

        return cluster;
    }

    constructor(options) {
        this.options = {
            ...DEFAULT_OPTIONS,
            ...options
        };

        this._workers = [];
        this._workersAvail = [];
        this._workersBusy = [];
        this._workersStarting = 0;

        this._allTargetCount = 0;
        this._queue = [];
        this._task = null;

        this._idleResolvers = [];

        this._browser = null;
        this._isClosed = false;

        this.monitoringInterval = null;
        if (this.options.monitor) {
            this.monitoringInterval = setInterval(
                () => this.monitor(),
                constants.CLUSTER_MONITORING_INTERVAL
            );
        }
    }

    async init() {
        if (this.options.concurrency === constants.CLUSTER_CONCURRENCY_PAGE
            || this.options.concurrency === constants.CLUSTER_CONCURRENCY_CONTEXT) {
            // use one browser for the whole cluster
            this._browser = await Browser.launch({
                args: this.options.args,
            });
        }

        // launch minimal number of workers
        for (let i = 0; i < this.options.minWorker; i++) {
            await this._launchWorker();
        }
    }

    async _launchWorker() {
        // signal, that we are starting a worker
        this._workersStarting++;

        const worker = await Worker.launch({
            cluster: this,
            args: this.options.args,
            concurrency: this.options.concurrency,
            browser: this._browser,
        });
        this._workersStarting--;
        if (this._isClosed) {
            // cluster was closed while we created a new worker (should rarely happen)
            worker.close();
        } else {
            this._workersAvail.push(worker);
            this._workers.push(worker);
        }
    }

    async setTask(taskHandler, name) {
        this._task = taskHandler;
        // TODO handle different names for tasks
    }

    async _work() {
        // find empty instance

        if (this._queue.length === 0) {
            if (this._workersBusy.length === 0) {
                this._idleResolvers.forEach(resolve => resolve());
            }
        } else {
            if (this._workersAvail.length !== 0) {
                // worker is available, lets go
                const worker = this._workersAvail.shift();
                this._workersBusy.push(worker);

                const target = this._queue.shift();
                await worker.handle(this._task, target);

                // add worker to available workers again
                const workerIndex = this._workersBusy.indexOf(worker);
                this._workersBusy.splice(workerIndex, 1);

                this._workersAvail.push(worker);

                this._work();
            } else if(this._allowedToStartWorker()) {
                await this._launchWorker();
                await this._work(); // call again to process queue
            } else {
                // currently no workers available!
            }
        }
    }

    _allowedToStartWorker() {
        const workerCount = this._workersBusy.length + this._workersAvail.length
            + this._workersStarting;
        return (workerCount < this.options.maxWorker);
    }

    async queue(url, context) {
        this._allTargetCount++;
        this._queue.push(new Target(url, context));
        this._work();
    }

    idle() {
        return new Promise(resolve => {
            this._idleResolvers.push(resolve);
        })
    }

    async close() {
        this._isClosed = true;

        // close workers
        this._workers.forEach(async worker => await worker.close());

        // close browser if necessary
        if (this._browser) {
            // use one browser for the whole cluster
            await this._browser.close();
        }

        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }
    }

    monitor() {
        if (!this.display) {
            this.display = new Display();
        }
        const display = this.display;

        display.resetCursor();

        const now = new Date();

        const doneTargets = this._allTargetCount - this._queue.length - this._workersBusy.length;
        const donePercentage = (doneTargets / this._allTargetCount).toFixed(2);

        display.log(now.toString());
        display.log(`== ${doneTargets} / ${this._allTargetCount} (${donePercentage}%) ==`);
        this._workers.forEach((worker, i) => {
            const isIdle = this._workersAvail.indexOf(worker) !== -1;
            let workOrIdle;
            let workerUrl = '';
            if (isIdle) {
                workOrIdle = 'IDLE';
            } else {
                workOrIdle = 'WORK';
                workerUrl = worker.activeTarget.url;
            }

            display.log(`#${i} ${workOrIdle} ${workerUrl}`);
        });
        for (let i = 0; i < this._workersStarting; i++) {
            display.log(`#${this._workers.length + i} STARTING...`)
        }

    }

}

Cluster.CONCURRENCY_PAGE = constants.CLUSTER_CONCURRENCY_PAGE;
Cluster.CONCURRENCY_CONTEXT = constants.CLUSTER_CONCURRENCY_CONTEXT;
Cluster.CONCURRENCY_BROWSER = constants.CLUSTER_CONCURRENCY_BROWSER;

module.exports = Cluster;
