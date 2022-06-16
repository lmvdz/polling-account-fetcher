import { Idl, Program } from "@project-serum/anchor";
import { request } from 'undici';

export type AccountToPoll<T> = {
    data: T // the latest data (account)
    raw: string // the latest raw data retrieved
    accountKey: string // account on the anchor program (used for decoding the buffer data returned by the rpc call)
    accountPublicKey: string // the publickey of the account
    program: Program<Idl> // the anchor program associated with the account
    slot: number // the latest slot from the retrieved data (to prevent updating to old data)
    constructAccount: (buffer: Buffer) => any // used by .addConstructAccount
    onFetch: (data: T) => void // called when new data is retrieved 
    onError: (error: any) => void // called when there was an error
}

// used to chunk the the array of publickeys ( to min/max the amount of accounts per RPC call )
export function chunk(array: Array<any>, chunk_size: number) : Array<any> {
    return new Array(Math.ceil(array.length / chunk_size)).fill(null).map((_, index) => index * chunk_size).map(begin => array.slice(begin, begin + chunk_size));
}
// used to flatten the array of chunked responses
export function flat(arr: Array<any>, d = 1) : Array<any> {
    return d > 0 ? arr.reduce((acc, val) => acc.concat(Array.isArray(val) ? flat(val, d - 1) : val), []) : arr.slice();
}

export class PollingAccountsFetcher {

    accounts: Map<string, AccountToPoll<any>>;
    MAX_KEYS = 100;
    frequency = 1000;
    requestsPerSecond = 5;
    interval: NodeJS.Timer;
    rpcURL: string;

    constructor(rpcURL: string, frequency?: number, requestsPerSecond?: number) {
        this.rpcURL = rpcURL;
        if (frequency !== undefined) {
            if (frequency < 0) {
                console.warn(`PollingAccountsFetcher constructor parameter frequency must be greater than or equal to 0 ms, defaulting to 1000 ms`);
            } else {
                this.frequency = frequency;
            }
        }
        if (requestsPerSecond !== undefined) {
            if (requestsPerSecond < 1) {
                console.warn(`PollingAccountsFetcher constructor parameter requestsPerSecond must be greater than or eqaul to 1, defaulting to 5 rps`);
            } else {
                this.requestsPerSecond = requestsPerSecond;
            }
        }
        this.accounts = new Map<string, AccountToPoll<any>>();
    }

    addProgram(accountKey: string, accountPublicKey: string, program: Program<Idl>, onFetch: (data: any) => void, onError: (error: any) => void, data?: any) {
        if (!this.accounts.has(accountPublicKey)) {
            this.accounts.set(accountPublicKey, { accountKey, accountPublicKey, program, onFetch, onError, data } as AccountToPoll<any>);
        }
    }

    addConstructAccount(accountPublicKey: string, constructAccount: (data: any) => any, onFetch: (data: any) => void, onError: (error: any) => void, data?: any) {
        if (!this.accounts.has(accountPublicKey)) {
            this.accounts.set(accountPublicKey, { accountPublicKey, constructAccount, onFetch, onError, data } as AccountToPoll<any>);
        }
    }

    start() {
        if(this.interval) {
            clearInterval(this.interval);   
        }
        this.interval = setInterval(() => {
            this.fetch();
        }, this.frequency);
    }

    stop() {
        if(this.interval) {
            clearInterval(this.interval);
        }
    }

    capitalize(value: string): string {
		return value[0].toUpperCase() + value.slice(1);
	}

    constructAccount(accountToPoll: AccountToPoll<any>, buffer: Buffer) : any {
        if (accountToPoll.program !== undefined) {
            return accountToPoll.program.account[
                accountToPoll.accountKey
            ].coder.accounts.decode(
                this.capitalize(accountToPoll.accountKey),
                buffer
            );
        } else if (accountToPoll.constructAccount !== undefined) {
            return accountToPoll.constructAccount(buffer);
        }
    }

    post(requestChunk, retry = 0) : Promise<any> {
        return new Promise((resolve) => {
            const data = requestChunk.map(payload => 
                ({
                    jsonrpc: "2.0",
                    id: "1",
                    method: "getMultipleAccounts",
                    params: [
                        payload,
                        { commitment: "processed" },
                    ]
                })
            );
            request(this.rpcURL, { body: data, method: 'POST'}).then(response => response.body.json()).then(data => resolve(data)).catch(error => {
                if (retry < 5) {
                    this.post(requestChunk, retry+1);
                } else {
                    console.error(error);
                    console.warn('failed to retrieve data 5 times in a row, aborting');
                }
            });
        });
    }

    async fetch() : Promise<void> {
        const accountValues = [...this.accounts.values()];
        // chunk accounts into groups of 100, 1 request can have 10 groups of 100, genesysgo can handle 10 requests a second (so we use 5 to not get rate limited)
        // this will handle 5k accounts every second :D
        const chunked = chunk(chunk(chunk(accountValues.map(x => x.accountPublicKey), this.MAX_KEYS), 10), this.requestsPerSecond > 10 ? 10 : this.requestsPerSecond);
        // const start = process.hrtime();
        const responses = flat(await Promise.all(chunked.map((request, index) => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    Promise.all(request.map((requestChunk) => {
                        return this.post(requestChunk);
                    })).then(promisedResponses => {
                        resolve(flat(promisedResponses, Infinity));
                    });
                }, index * (this.requestsPerSecond > 10 ? 1000/(this.requestsPerSecond/10) : 1000) );
            });
        })), Infinity);

        // const end = process.hrtime(start);
        // console.log(`took ${ ((end[0] * 1000) + (end[1] / 1000000)).toFixed(2) } ms to poll ${accountValues.length} accounts`);

        for(let x = 0; x < accountValues.length; x++) {
            const accountToPoll = accountValues[x];
            let accIndex = x;
            const responseIndex = Math.floor(accIndex / this.MAX_KEYS);
            const response = responses[responseIndex];
            while (accIndex >= this.MAX_KEYS) {
                accIndex -= this.MAX_KEYS;
            }
            try {
                if ((response as any).result.value[ accIndex ] !== null) {
                    const slot = (response as any).result.context.slot;
                    if (accountToPoll.slot === undefined || slot > accountToPoll.slot) {
                        accountToPoll.slot = slot;
                        const raw = (response as any).result.value[ accIndex ].data[0] as string;
                        const dataType = (response as any).result.value[ accIndex ].data[1] as BufferEncoding;
                        const account = this.constructAccount(accountToPoll, Buffer.from(raw, dataType));
                        if (accountToPoll.raw !== raw) {
                            accountToPoll.data = account;
                            accountToPoll.raw = raw;
                            accountToPoll.onFetch(account);
                        }
                    }
                } else {
                    // this usually happens when the account get closed
                    console.warn(`account returned null: ${accountToPoll.accountPublicKey} - ${accountToPoll.accountKey}, removing!`);
                    this.accounts.delete(accountToPoll.accountPublicKey);
                }
                
            } catch (error) {
                // console.log(response, responseIndex, responses.length, accIndex, x, accountToPoll.accountKey, accountToPoll.accountPublicKey, accountToPoll.data);
                accountToPoll.onError(error);
            }
        }
    }
}