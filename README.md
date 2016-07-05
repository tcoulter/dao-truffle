# DAO + Truffle

This project is the currently-deployed DAO contract code reorganized into a Truffle project. It uses the latest-and-greatest Truffle (on the `develop` branch). This project can provide developers with a quick start for interacting with the DAO, as well as provide a framework for finding issues that might help in the DarkDAO fund retrieval.

### Installation

As mentioned, this project uses the latest Truffle on the `develop` branch. To get started, first uninstall Truffle if you have it installed already:

```
$ npm uninstall -g truffle
```

Now, download and install the `develop` branch.

```
$ git clone https://github.com/ConsenSys/truffle.git
$ cd truffle
$ git checkout develop
$ npm install -g .
```

Once Truffle is installed, we can now checkout The DAO code:

```
$ git clone https://github.com/tcoulter/dao-truffle.git
$ cd dao-truffle
```

Be sure to check out the [Truffle documentation for the develop branch](http://truffle.readthedocs.io/en/develop/).

### Usage Example: Interacting with the DarkDAO

You can now use this project as if it were any other Truffle project. However, there's one use case I'd like to highlight, which is interacting with the DarkDAO.

The DarkDAO exists at address: `0x304a554a310c7e546dfe434669c62820b7d83490`

To interact directly with it, ensure you have a live `geth` client running on port `8545`, then open the console:

```
$ cd dao-truffle
$ truffle console
truffle(default)> var DarkDAO = DAO.at("0x304a554a310c7e546dfe434669c62820b7d83490");
truffle(default)> DarkDAO.totalSupply.call().then(function(total) {console.log(web3.fromWei(total).toNumber())})
3641694.241898507
```
