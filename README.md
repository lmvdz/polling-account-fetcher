# polling-account-fetcher
Polls solana accounts (program and custom decode)

### Building from source

```
yarn install
yarn build
```

### Overview

The polling account fetcher was created in response to the GenesysGo rate limit on their previously free unlimited RPC  
By sending 10 x 100 publickeys in one getMultipleAccounts rpc call we can theoretically reach 10k accounts per second.

### How it works

Depending on if you are using a anchor program or a custom decoding function you can add a public key to the accounts map via the provided `addProgram` or `addConstrucAccount` methods.  
The PollingAccountFetcher constructor takes two parameters: `frequency` ( in milliseconds ) and `requestsPerSecond`  
The `PollingAccountFetcher.fetch()` is called by `setInterval(() => {}, frequency)`  
Once all the data is returned, the pollingAccountFetcher will parse each returned account data and send the data back through the AccountToPoll's `onFetch(data: any) => void` callback  
If there is an issue during the rpc call it will retry 5 times before aborting

### Usage

set the `RPC_URL` environment variable

```ts
import { PollingAccountsFetcher } from 'polling-accounts-fetcher';

// new PollingAccountsFetcher(frequencyInMS: number, requestsPerSecond: number)
const pollingAccountsFetcher = new PollingAccountsFetcher(1000, 5);

// this example of adding a program account uses the 'accountKey' to decode the data received from the getMultipleAccounts rpc call
pollingAccountsFetcher.addProgram(accountKey, accountPublicKey, Program<Idl>, ((data : any) => {
    console.log(data);
}), (error => {
    console.error(error);
}), initialAccountData?);

//this example of adding an account but uses a custom decode function (not an anchor program)
pollingAccountsFetcher.addConstructAccount(accountPublicKey, (data: Buffer) => {
        // function used to parse the account buffer
        return parseAccountBuffer(data);
    }, async (decodedAccountData: any) => {
        // do something with the decodedAccountData
    }, (error) => {
        console.error(error);
    });
});

// start the account polling
pollingAccountsFetcher.start();

// stop the account polling
pollingAccountsFetcher.stop();

// the latest data on any account can be accesed through the accounts map: Map<string, AccountToPoll<T>>
const account = pollingAccountsFetcher.accounts.get(publicKey.toBase58())
```


```ts
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
```

```ts
// this is called by the polling account fetcher, it is here to help in understanding of how the polling account fetcher works
// this is how the polling account fetcher decodes the data retrieved from the RPC call
// if the accountToPoll has an associated anchor program, use the anchor program to decode the account
// otherwise if there is a custom decode function on the accountToPoll use that
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
```

