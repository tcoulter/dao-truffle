#!/usr/bin/env node

var TestRPC = require("ethereumjs-testrpc");
var Web3 = require("web3");
var async = require("async");
var moment = require("moment");

var DAOContract = require("./build/contracts/DAO.sol.js");

var web3 = new Web3(TestRPC.provider({
  fallback: "http://localhost:8545",
  fallback_block_number: "latest",
  verbose: true,
  logger: console
}));

web3.eth.getAccounts(function(err, accounts) {
  // Setup contract abstractions for ease of use.
  [DAOContract].forEach(function(contract) {
    contract.setProvider(web3.currentProvider);
    contract.defaults({
      gas: 4e6,
      from: accounts[0]
    })
  });

  var DAO = DAOContract.at("0xbb9bc244d798123fde783fcc1c72d3bb8c189413");

  async.series([
    getCode
    // Step 1: Participate in presale. Get DAO tokens before cutoff ends.
    //participateInPresale

    //makeProposal
  ], function(err) {
    if (err) {
      console.log(err);
      process.exit(1);
    }
  });

  function increaseTime(duration) {
    return function(callback) {
      var seconds = moment.duration.apply(moment.duration, duration.split(" ")).asSeconds();

      web3.currentProvider.sendAsync({
        jsonrpc: "2.0",
        method: "evm_increaseTime",
        params: [seconds],
        id: new Date().getTime()
      }, callback);
    }
  }

  function getCode(callback) {
    web3.eth.getCode(DAO.address, function(err, res) {
      console.log(err, res)
    })
  }

  function participateInPresale(callback) {
    console.log("Buying into presale...");

    web3.eth.sendTransaction({
      from: accounts[0],
      to: DAO.address,
      value: web3.toWei(10, "Ether"),
      gas: 90000
    }, function(err) {
      if (err) return callback(err);

      DAO.balanceOf(accounts[0], function(err, balance) {
        if (err) return callback(err);

        console.log(balance);
      })
    })
  }

});
