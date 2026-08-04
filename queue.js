class ProcessingQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.maxRetries = 3;
    }

    async add(job) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                job,
                resolve,
                reject,
                retries: 0
            });
            this.process();
        });
    }

    async process() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        const { job, resolve, reject, retries } = this.queue.shift();

        try {
            const result = await job();
            resolve(result);
        } catch (error) {
            if (retries < this.maxRetries) {
                console.log(`Retrying job (${retries + 1}/${this.maxRetries})...`);
                this.queue.unshift({
                    job,
                    resolve,
                    reject,
                    retries: retries + 1
                });
            } else {
                console.error('Job failed after max retries:', error);
                reject(error);
            }
        } finally {
            this.processing = false;
            setImmediate(() => this.process());
        }
    }

    getQueueLength() {
        return this.queue.length;
    }

    isProcessing() {
        return this.processing;
    }

    clear() {
        this.queue = [];
        this.processing = false;
    }
}

module.exports = new ProcessingQueue();