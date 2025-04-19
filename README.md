# Tiny Condor

a tiny but useful record based db

Ever wanted a quick and easy way to store data in your app directly as JSON records? Tiny Condor is the answer.

## Quick Start

You can save any type of data. The only requirement is the record must be identified by an `id` field.

```ts
type CondorRec = {
    id: string;
    tm?: number;
};
```

The interface is also simple:

```js
const data : (CondorRec[] | null) = await create(initialRecords, dbfile, onErrors);
const data : (CondorRec[] | null) = await load(dbfile, onErrors);
const data : (CondorRec[] | null) = await save(recordArray, dbfile, onErrors);
clearCache(dbfile); // to free up memory
```

The `onErrors` callback receives database errors on loading/saving records:

```js
const onErrorsHandler = ({ message, code, record }) => {
    // ALWAYS AVAILABLE
    //  message -- error message useful for logging
    //
    // OPTIONAL
    //  code -- EEXIST if trying to create an already existing db
    //  record -- record which failed to be loaded/saved
    //  err -- error object if thrown with stack etc
};
```
