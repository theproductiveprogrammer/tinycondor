# Tiny Condor

a tiny but useful record based db

Ever wanted a quick and easy way to store data in your app directly as JSON records? Tiny Condor is the answer.

## Quick Start

You can save any type of data. The only requirement is the record must be identified by an `id` field.

A helper function `genDbId(type: string) : string` can help generate a new id.

The interface is also simple:

```js
const err = create(initialRecords, dbfile); // {code:'EEXISTS'} if already exists, null if successful, or other errors
const data = load(dbfile);
const updated = save(recordArray, dbfile);
```
