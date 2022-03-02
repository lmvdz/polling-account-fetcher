import { Idl, Program } from "@project-serum/anchor";
import axios from "axios";

export type AccountToPoll<T> = {
    data: T // the data 
    raw: string
    accountKey: string // account on the anchor program (used for decoding the buffer data returned by the rpc call)
    accountPublicKey: string
    program: Program<Idl>
    slot: number
    constructAccount: (buffer: Buffer) => any
    onFetch: (data: T) => void
    onError: (error: any) => void
}


export function chunk(array: Array<any>, chunk_size: number) : Array<any> {
    return new Array(Math.ceil(array.length / chunk_size)).fill(null).map((_, index) => index * chunk_size).map(begin => array.slice(begin, begin + chunk_size));
}

export function flat(arr: Array<any>, d = 1) : Array<any> {
    return d > 0 ? arr.reduce((acc, val) => acc.concat(Array.isArray(val) ? flat(val, d - 1) : val), []) : arr.slice();
}

export class PollingAccountsFetcher {
    accounts: Map<string, AccountToPoll<any>>;
    MAX_KEYS = 100;
    frequency = 1000;
    requestsPerSecond = 5;
    interval: NodeJS.Timer;
    constructor(frequency?: number, requestsPerSecond?: number) {
        if (frequency < 0) {
            console.warn(`PollingAccountsFetcher constructor parameter frequency must be greater than or equal to 0 ms, defaulting to 1000 ms`);
        } else {
            this.frequency = frequency;
        }
        
        if (requestsPerSecond < 1) {
            console.warn(`PollingAccountsFetcher constructor parameter requestsPerSecond must be greater than or eqaul to 1, defaulting to 5 rps`);
        } else {
            this.requestsPerSecond = requestsPerSecond;
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

    constructAccount(accountToPoll: AccountToPoll<any>, raw: string, dataType: BufferEncoding) : any {
        if (accountToPoll.program !== undefined) {
            return accountToPoll.program.account[
                accountToPoll.accountKey
            ].coder.accounts.decode(
                this.capitalize(accountToPoll.accountKey),
                Buffer.from(raw, dataType)
            );
        } else if (accountToPoll.constructAccount !== undefined) {
            return accountToPoll.constructAccount(Buffer.from(raw, dataType));
        }
        
    }

    axiosPost(requestChunk, retry = 0) : Promise<any> {
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
            axios.post(process.env.RPC_URL, data).then(response => {
                resolve(response.data);
            }).catch(error => {
                if (retry < 5) {
                    this.axiosPost(requestChunk, retry+1);
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
                        return this.axiosPost(requestChunk);
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
                        const raw: string = (response as any).result.value[ accIndex ].data[0];
                        const dataType = (response as any).result.value[ accIndex ].data[1] as BufferEncoding;
                        const account = this.constructAccount(accountToPoll, raw, dataType);
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