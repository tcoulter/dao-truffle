var Web3 = require("web3");
var SolidityEvent = require("web3/lib/web3/event.js");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, instance, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var decodeLogs = function(logs) {
            return logs.map(function(log) {
              var logABI = C.events[log.topics[0]];

              if (logABI == null) {
                return null;
              }

              var decoder = new SolidityEvent(null, logABI, instance.address);
              return decoder.decode(log);
            }).filter(function(log) {
              return log != null;
            });
          };

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  // If they've opted into next gen, return more information.
                  if (C.next_gen == true) {
                    return accept({
                      tx: tx,
                      receipt: receipt,
                      logs: decodeLogs(receipt.logs)
                    });
                  } else {
                    return accept(tx);
                  }
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], instance, constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("DAO error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("DAO error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("DAO contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of DAO: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to DAO.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: DAO not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "proposals",
        "outputs": [
          {
            "name": "recipient",
            "type": "address"
          },
          {
            "name": "amount",
            "type": "uint256"
          },
          {
            "name": "description",
            "type": "string"
          },
          {
            "name": "votingDeadline",
            "type": "uint256"
          },
          {
            "name": "open",
            "type": "bool"
          },
          {
            "name": "proposalPassed",
            "type": "bool"
          },
          {
            "name": "proposalHash",
            "type": "bytes32"
          },
          {
            "name": "proposalDeposit",
            "type": "uint256"
          },
          {
            "name": "newCurator",
            "type": "bool"
          },
          {
            "name": "yea",
            "type": "uint256"
          },
          {
            "name": "nay",
            "type": "uint256"
          },
          {
            "name": "creator",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_spender",
            "type": "address"
          },
          {
            "name": "_amount",
            "type": "uint256"
          }
        ],
        "name": "approve",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "minTokensToCreate",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "rewardAccount",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "daoCreator",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "totalSupply",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "divisor",
        "outputs": [
          {
            "name": "divisor",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "extraBalance",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          },
          {
            "name": "_transactionData",
            "type": "bytes"
          }
        ],
        "name": "executeProposal",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_from",
            "type": "address"
          },
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transferFrom",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "unblockMe",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "totalRewardToken",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "actualBalance",
        "outputs": [
          {
            "name": "_actualBalance",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "closingTime",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "allowedRecipients",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transferWithoutReward",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "refund",
        "outputs": [],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_recipient",
            "type": "address"
          },
          {
            "name": "_amount",
            "type": "uint256"
          },
          {
            "name": "_description",
            "type": "string"
          },
          {
            "name": "_transactionData",
            "type": "bytes"
          },
          {
            "name": "_debatingPeriod",
            "type": "uint256"
          },
          {
            "name": "_newCurator",
            "type": "bool"
          }
        ],
        "name": "newProposal",
        "outputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "DAOpaidOut",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "minQuorumDivisor",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_newContract",
            "type": "address"
          }
        ],
        "name": "newContract",
        "outputs": [],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "_owner",
            "type": "address"
          }
        ],
        "name": "balanceOf",
        "outputs": [
          {
            "name": "balance",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_recipient",
            "type": "address"
          },
          {
            "name": "_allowed",
            "type": "bool"
          }
        ],
        "name": "changeAllowedRecipients",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "halveMinQuorum",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "paidOut",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          },
          {
            "name": "_newCurator",
            "type": "address"
          }
        ],
        "name": "splitDAO",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "DAOrewardAccount",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "proposalDeposit",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "numberOfProposals",
        "outputs": [
          {
            "name": "_numberOfProposals",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "lastTimeMinQuorumMet",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_toMembers",
            "type": "bool"
          }
        ],
        "name": "retrieveDAOReward",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "receiveEther",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transfer",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "isFueled",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_tokenHolder",
            "type": "address"
          }
        ],
        "name": "createTokenProxy",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          }
        ],
        "name": "getNewDAOAddress",
        "outputs": [
          {
            "name": "_newDAO",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          },
          {
            "name": "_supportsProposal",
            "type": "bool"
          }
        ],
        "name": "vote",
        "outputs": [
          {
            "name": "_voteID",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "getMyReward",
        "outputs": [
          {
            "name": "_success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "rewardToken",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_from",
            "type": "address"
          },
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transferFromWithoutReward",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "_owner",
            "type": "address"
          },
          {
            "name": "_spender",
            "type": "address"
          }
        ],
        "name": "allowance",
        "outputs": [
          {
            "name": "remaining",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_proposalDeposit",
            "type": "uint256"
          }
        ],
        "name": "changeProposalDeposit",
        "outputs": [],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "blocked",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "curator",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "_proposalID",
            "type": "uint256"
          },
          {
            "name": "_recipient",
            "type": "address"
          },
          {
            "name": "_amount",
            "type": "uint256"
          },
          {
            "name": "_transactionData",
            "type": "bytes"
          }
        ],
        "name": "checkProposalCode",
        "outputs": [
          {
            "name": "_codeChecksOut",
            "type": "bool"
          }
        ],
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "privateCreation",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "type": "function"
      },
      {
        "inputs": [
          {
            "name": "_curator",
            "type": "address"
          },
          {
            "name": "_daoCreator",
            "type": "address"
          },
          {
            "name": "_proposalDeposit",
            "type": "uint256"
          },
          {
            "name": "_minTokensToCreate",
            "type": "uint256"
          },
          {
            "name": "_closingTime",
            "type": "uint256"
          },
          {
            "name": "_privateCreation",
            "type": "address"
          }
        ],
        "type": "constructor"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "recipient",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "amount",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "newCurator",
            "type": "bool"
          },
          {
            "indexed": false,
            "name": "description",
            "type": "string"
          }
        ],
        "name": "ProposalAdded",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "position",
            "type": "bool"
          },
          {
            "indexed": true,
            "name": "voter",
            "type": "address"
          }
        ],
        "name": "Voted",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "result",
            "type": "bool"
          },
          {
            "indexed": false,
            "name": "quorum",
            "type": "uint256"
          }
        ],
        "name": "ProposalTallied",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_newCurator",
            "type": "address"
          }
        ],
        "name": "NewCurator",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_recipient",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_allowed",
            "type": "bool"
          }
        ],
        "name": "AllowedRecipientChanged",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "FuelingToDate",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "amount",
            "type": "uint256"
          }
        ],
        "name": "CreatedToken",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "Refund",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_from",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_amount",
            "type": "uint256"
          }
        ],
        "name": "Transfer",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_owner",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_spender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_amount",
            "type": "uint256"
          }
        ],
        "name": "Approval",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x606060405260405160c0806133cd8339610120604052905160805160a051925160e05161010051939492938282826003829055600483905560058054610100830261010060a860020a031990911617905560405130906001906101f1806103428339600160a060020a03909316908301526101408201526040519081900361016001906000f060068054600160a060020a0319169190911790555050600b8054600160a060020a03199081168917909155601680549091168717905550601484905560405130906000906101f1806105338339018083600160a060020a03168152602001821515815260200192505050604051809103906000f0600f60006101000a815481600160a060020a03021916908302179055503060006040516101f1806107248339018083600160a060020a03168152602001821515815260200192505050604051809103906000f060108054600160a060020a031916919091179055600f54600160a060020a03166000141561017957610002565b601054600160a060020a03166000141561019257610002565b42600a5560056009556008805460018083559190829080158290116101d057600e0281600e0283600052602060002091820191016101d0919061024b565b50505030600160a060020a039081166000908152600c6020526040808220805460ff199081166001908117909255600b5490941683529120805490921617905550505050505050612ab8806109156000396000f35b5050600060098201819055600a820155600d81018054600160a060020a0319169055600e015b8082111561033e578054600160a060020a03191681556000600182810182905560028381018054848255909281161561010002600019011604601f81901061031057505b506000600383018190556004838101805461ffff19169055600584018290556006840182905560078401805460ff191690556008840180548382559083526020909220610225929091028101905b8082111561033e576000808255600182018190556002820155600381018054600160a060020a03191690556004016102dd565b601f01602090049060005260206000209081019061028f91905b8082111561033e576000815560010161032a565b50905660606040818152806101f1833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561019790819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100ac5780638da5cb5b146100c0578063d2cc718f146100d2575b6100db6001805434019055565b6100dd6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a2575060005460a060020a900460ff1680156100a25750600054600160a060020a03848116911614155b1561012057610002565b6100dd60005460ff60a060020a9091041681565b6100f1600054600160a060020a031681565b61010e60015481565b005b604080519115158252519081900360200190f35b60408051600160a060020a03929092168252519081900360200190f35b60408051918252519081900360200190f35b604051600160a060020a038416908390600081818185876185025a03f1925050501561018d57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a2506001610191565b5060005b929150505660606040818152806101f1833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561019790819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100ac5780638da5cb5b146100c0578063d2cc718f146100d2575b6100db6001805434019055565b6100dd6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a2575060005460a060020a900460ff1680156100a25750600054600160a060020a03848116911614155b1561012057610002565b6100dd60005460ff60a060020a9091041681565b6100f1600054600160a060020a031681565b61010e60015481565b005b604080519115158252519081900360200190f35b60408051600160a060020a03929092168252519081900360200190f35b60408051918252519081900360200190f35b604051600160a060020a038416908390600081818185876185025a03f1925050501561018d57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a2506001610191565b5060005b929150505660606040818152806101f1833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561019790819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100ac5780638da5cb5b146100c0578063d2cc718f146100d2575b6100db6001805434019055565b6100dd6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a2575060005460a060020a900460ff1680156100a25750600054600160a060020a03848116911614155b1561012057610002565b6100dd60005460ff60a060020a9091041681565b6100f1600054600160a060020a031681565b61010e60015481565b005b604080519115158252519081900360200190f35b60408051600160a060020a03929092168252519081900360200190f35b60408051918252519081900360200190f35b604051600160a060020a038416908390600081818185876185025a03f1925050501561018d57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a2506001610191565b5060005b92915050566060604052361561020e5760e060020a6000350463013cf08b8114610247578063095ea7b3146102c75780630c3b7b961461033c5780630e70820314610345578063149acf9a1461035757806318160ddd146103695780631f2dc5ef1461037257806321b5b8dd14610392578063237e9492146103a457806323b872dd146104075780632632bf201461043a578063341458081461046f57806339d1f908146104785780634b6753bc146104905780634df6d6cc146104995780634e10c3ee146104b4578063590e1ae3146104c7578063612e45a3146104d8578063643f7cdd14610577578063674ed0661461058f5780636837ff1e1461059857806370a08231146105e2578063749f98891461060857806378524b2e1461062157806381f03fcb1461067b57806382661dc41461069357806382bf6464146106b45780638b15a605146106c65780638d7af473146106cf57806396d7f3f5146106de578063a1da2fb9146106e7578063a3912ec814610701578063a9059cbb1461070c578063b7bc2c841461073c578063baac530014610748578063be7c29c1146107b0578063c9d27afe14610814578063cc9ae3f61461082a578063cdef91d01461083e578063dbde198814610856578063dd62ed3e1461087b578063e33734fd146108af578063e5962195146108c3578063e66f53b7146108db578063eceb2945146108ed578063f8c80d261461094c575b6109636003546000906234bc000142108015610239575060065433600160a060020a03908116911614155b156109775761097f3361074f565b6109856004356008805482908110156100025790600052602060002090600e020160005060038101546004820154600683015460018401548454600786015460058701546009880154600a890154600d8a0154600160a060020a039586169b509599600201989760ff81811698610100909204811697949691951693168c565b61096360043560243533600160a060020a03908116600081815260016020908152604080832094871680845294825280832086905580518681529051929493927f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925929181900390910190a35060015b92915050565b610a8660045481565b610a98600f54600160a060020a031681565b610a98601654600160a060020a031681565b610a8660025481565b610a865b60004262127500600360005054031115610bc257506014610982565b610a98600654600160a060020a031681565b60408051602060248035600481810135601f810185900485028601850190965285855261096395813595919460449492939092019181908401838280828437509496505050505050506000600060006000600060006000341115610c4057610002565b6109636004356024356044355b60055460009060ff16801561042a575060035442115b8015611218575061121684610444565b610963600061097f335b600160a060020a038116600090815260136020526040812054819081141561269a5760009150612711565b610a86600e5481565b610a865b60155430600160a060020a03163103610982565b610a8660035481565b610963600435600c6020526000908152604090205460ff1681565b610963600435602435600061126761082e565b610ab5600034111561128357610002565b604080516020604435600481810135601f8101849004840285018401909552848452610a86948135946024803595939460649492939101918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a01909352828252969897608497919650602491909101945090925082915084018382808284375094965050933593505060a435915050600060006114c4336105e9565b610a8660043560116020526000908152604090205481565b610a8660095481565b610ab560043530600160a060020a031633600160a060020a03161415806105d85750600160a060020a0381166000908152600c602052604090205460ff16155b15611a0857611a05565b610a866004355b600160a060020a0381166000908152602081905260409020545b919050565b61096360043560243560006000341115611a3957610002565b610963600062e6b6804203600a60005054108061064d5750600b54600160a060020a0390811633909116145b80156106615750600a54621274ff19420190105b15611ab6575042600a556009805460020290556001610982565b610a8660043560126020526000908152604090205481565b610963600435602435600060006000600060006000341115611abe57610002565b610a98601054600160a060020a031681565b610a8660145481565b610a8660085460001901610982565b610a86600a5481565b610963600435600060006000600034111561209a57610002565b6109635b6001610982565b6109636004356024355b60055460009060ff16801561072c575060035442115b801561231b575061231933610444565b61096360055460ff1681565b6109636004355b600060006000600360005054421080156107695750600034115b80156107a357506005546101009004600160a060020a0316600014806107a357506005546101009004600160a060020a0390811633909116145b15610bbd57610ab7610376565b610a9860043560006008600050828154811015610002575081527ff3f7a9fe364faab93b216da50a3214154f22a0a2b415b23a84c8169e8b636eeb600e83020180548290811015610002575081526020902060030154600160a060020a0316610603565b610a8660043560243560006000612356336105e9565b6109635b6000600034111561257657610002565b610a86600435600d6020526000908152604090205481565b610963600435602435604435600061257f845b60006000600034111561286757610002565b610a86600435602435600160a060020a03828116600090815260016020908152604080832093851683529290522054610336565b610ab5600435600034111561259557610002565b610a8660043560136020526000908152604090205481565b610a98600b54600160a060020a031681565b604080516020606435600481810135601f8101849004840285018401909552848452610963948135946024803595604435956084949201919081908401838280828437509496505050505050506000600060003411156125e957610002565b610a986005546101009004600160a060020a031681565b604080519115158252519081900360200190f35b61097f610705565b90505b90565b604051808d600160a060020a031681526020018c8152602001806020018b81526020018a15158152602001891515815260200188600019168152602001878152602001861515815260200185815260200184815260200183600160a060020a0316815260200182810382528c818154600181600116156101000203166002900481526020019150805460018160011615610100020316600290048015610a6c5780601f10610a4157610100808354040283529160200191610a6c565b820191906000526020600020905b815481529060010190602001808311610a4f57829003601f168201915b50509d505050505050505050505050505060405180910390f35b60408051918252519081900360200190f35b60408051600160a060020a03929092168252519081900360200190f35b005b600654604051601434908102939093049450600160a060020a039091169184900390600081818185876185025a03f1600160a060020a03881660008181526020818152604080832080548b019055600280548b0190556007825291829020805434019055815189815291519397509195507fdbccb92686efceafb9bb7e0394df7f58f71b954061b81afb57109bf247d3d75a9450829003019150a260045460025410801590610b69575060055460ff16155b15610bb1576005805460ff1916600117905560408051600254815290517ff381a3e2428fdda36615919e8d9c35878d9eb0cf85ac6edf575088e80e4c147e9181900360200190a15b600192505b5050919050565b610002565b4262054600600360005054031115610bf0576201518062127500600360005054034203046014019050610982565b50601e610982565b6040805187151581526020810183905281518a927fdfc78bdca8e3e0b18c16c5c99323c6cb9eb5e00afde190b4e7273f5158702b07928290030190a25b505050505092915050565b60088054899081101561000257506000527ff3f7a9fe364faab93b216da50a3214154f22a0a2b415b23a84c8169e8b636eea600e890290810154600080516020612a9883398151915291909101955060ff16610c9f57620d2f00610ca4565b622398805b600486015490945060ff168015610cc057506003850154840142115b15610cce57610d6888610e40565b6003850154421080610ce55750600485015460ff16155b80610d5e575060405160018601548654600160a060020a0316606060020a8102835260148301829052895190928a916034820190602084810191908190849082908590600090600490601f850104600302600f01f150905001935050505060405180910390206000191685600501600050546000191614155b15610e8e57610002565b610c35565b60048501805461ff001916610100179055845460019650600160a060020a039081163090911614801590610db157508454600f54600160a060020a03908116911614155b8015610dcd57506010548554600160a060020a03908116911614155b8015610de957506006548554600160a060020a03908116911614155b8015610e055750600b548554600160a060020a03908116911614155b15610e3b5760018501805430600160a060020a03166000908152600d60205260409020805491909101905554600e805490910190555b610bf8885b600060086000508281548110156100025790600052602060002090600e0201600050600481015490915060ff1615610e8057601580546006830154900390555b600401805460ff1916905550565b8454610f4090600160a060020a03165b600160a060020a0381166000908152600c602052604081205460ff1680610f335750600654600160a060020a03908116908316148015610f335750600660009054906101000a9004600160a060020a0316600160a060020a031663d2cc718f6040518160e060020a0281526004018090506020604051808303816000876161da5a03f11561000257505060405151600e541190505b1561267757506001610603565b1515610f4f57610f5b88610e40565b60019150610f8d61047c565b604051600d8601546006870154600160a060020a0391909116916000919082818181858883f193505050509250610c35565b60018601541115610f9d57600091505b50600a8401546009850154875191019060049010801590610fec575086600081518110156100025790602001015160f860020a900460f860020a02600160f860020a031916606860f860020a02145b8015611026575086600181518110156100025790602001015160f860020a900460f860020a02600160f860020a031916603760f860020a02145b8015611060575086600281518110156100025790602001015160f860020a900460f860020a02600160f860020a03191660ff60f860020a02145b801561109a575086600381518110156100025790602001015160f860020a900460f860020a02600160f860020a031916601e60f860020a02145b80156110c9575030600160a060020a03166000908152600d60205260409020546110c6906110e161047c565b81105b156110d357600091505b6001850154611104906110e3565b015b30600160a060020a03166000908152600d602052604081205461267f61047c565b811061115857604051600d8601546006870154600160a060020a0391909116916000919082818181858883f19350505050151561114057610002565b42600a55600254600590048111156111585760056009555b6001850154611166906110e3565b811015801561117c5750600a8501546009860154115b80156111855750815b15610e3b57604051600186015486548951600160a060020a0391909116928a918190602084810191908190849082908590600090600490601f850104600302600f01f150905090810190601f1680156111f25780820380516001836020036101000a031916815260200191505b5091505060006040518083038185876185025a03f1925050501515610d6d57610002565b155b801561123357506112338484845b60006000612717856105e9565b801561125057506112508484846000600034111561277e57610002565b15610bbd57506001611260565b90505b9392505050565b151561127257610002565b61127c8383610716565b9050610336565b60035442118015611297575060055460ff16155b156114c257600660009054906101000a9004600160a060020a0316600160a060020a031663d2cc718f6040518160e060020a0281526004018090506020604051808303816000876161da5a03f1156100025750506040516006549051600160a060020a0391909116311090506113a8576040805160065460e060020a63d2cc718f0282529151600160a060020a039290921691630221038a913091849163d2cc718f91600482810192602092919082900301816000876161da5a03f11561000257505060408051805160e160020a63011081c5028252600160a060020a039490941660048201526024810193909352516044838101936020935082900301816000876161da5a03f115610002575050505b33600160a060020a0316600081815260076020526040808220549051909181818185876185025a03f192505050156114c25733600160a060020a03167fbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d6007600050600033600160a060020a03168152602001908152602001600020600050546040518082815260200191505060405180910390a26000600050600033600160a060020a0316815260200190815260200160002060005054600260008282825054039250508190555060006000600050600033600160a060020a031681526020019081526020016000206000508190555060006007600050600033600160a060020a03168152602001908152602001600020600050819055505b565b600014156114d157610002565b82801561151b57508660001415806114eb57508451600014155b806115035750600b54600160a060020a038981169116145b8061150e5750600034115b8061151b575062093a8084105b1561152557610002565b82158015611545575061153788610e9e565b158061154557506212750084105b1561154f57610002565b6249d40084111561155f57610002565b60055460ff161580611572575060035442105b80611587575060145434108015611587575082155b1561159157610002565b4284420110156115a057610002565b30600160a060020a031633600160a060020a031614156115bf57610002565b60088054600181018083559091908280158290116115f657600e0281600e0283600052602060002091820191016115f691906116b2565b505060088054929450918491508110156100025790600052602060002090600e02016000508054600160a060020a031916891781556001818101899055875160028381018054600082815260209081902096975091959481161561010002600019011691909104601f908101829004840193918b01908390106117a957805160ff19168380011785555b506117d9929150611791565b5050600060098201819055600a820155600d81018054600160a060020a0319169055600e015b808211156117a5578054600160a060020a03191681556000600182810182905560028381018054848255909281161561010002600019011604601f81901061177757505b506000600383018190556004838101805461ffff19169055600584018290556006840182905560078401805460ff19169055600884018054838255908352602090922061168c929091028101905b808211156117a5576000808255600182018190556002820155600381018054600160a060020a0319169055600401611744565b601f0160209004906000526020600020908101906116f691905b808211156117a55760008155600101611791565b5090565b82800160010185558215611680579182015b828111156116805782518260005055916020019190600101906117bb565b50508787866040518084600160a060020a0316606060020a0281526014018381526020018280519060200190808383829060006004602084601f0104600302600f01f150905001935050505060405180910390208160050160005081905550834201816003016000508190555060018160040160006101000a81548160ff02191690830217905550828160070160006101000a81548160ff0219169083021790555082156118bf57600881018054600181018083559091908280158290116118ba576004028160040283600052602060002091820191016118ba9190611744565b505050505b600d81018054600160a060020a03191633179055346006820181905560158054909101905560408051600160a060020a038a16815260208181018a905285151592820192909252608060608201818152895191830191909152885185937f5790de2c279e58269b93b12828f56fd5f2bc8ad15e61ce08572585c81a38756f938d938d938a938e93929160a084019185810191908190849082908590600090600490601f850104600302600f01f150905090810190601f1680156119965780820380516001836020036101000a031916815260200191505b509550505050505060405180910390a2509695505050505050565b30600160a060020a039081166000818152600d602090815260408083208054958716808552828520805490970190965584845283905560119091528082208054948352908220805490940190935590815290555b50565b604051600160a060020a0382811691309091163190600081818185876185025a03f19250505015156119b157610002565b600b54600160a060020a039081163390911614611a5557610002565b600160a060020a0383166000818152600c6020908152604091829020805460ff1916861790558151851515815291517f73ad2a153c8b67991df9459024950b318a609782cee8c7eeda47b905f9baa91f9281900390910190a2506001610336565b506000610982565b611ac7336105e9565b60001415611ad457610002565b6008805488908110156100025750600052600e87027ff3f7a9fe364faab93b216da50a3214154f22a0a2b415b23a84c8169e8b636ee6810154600080516020612a98833981519152919091019450421080611b3757506003840154622398800142115b80611b5057508354600160a060020a0390811690871614155b80611b605750600784015460ff16155b80611b86575033600160a060020a03166000908152600b8501602052604090205460ff16155b80611bba575033600160a060020a03166000908152601360205260409020548714801590611bba5750604060009081205414155b15611bc457610002565b600884018054600090811015610002579081526020812060030154600160a060020a03161415611d3357611e2486604051600090600160a060020a038316907f9046fefd66f538ab35263248a44217dcb70e2eb2cd136629e141b8b8f9f03b60908390a2604080516016547fe2faf044000000000000000000000000000000000000000000000000000000008252600160a060020a03858116600484015260248301859052604483018590526223988042016064840152925192169163e2faf04491608480820192602092909190829003018187876161da5a03f1156100025750506040515191506106039050565b6008850180546000908110156100025781815260208082209390935530600160a060020a03168152600d909252604082205481549092908110156100025790815260208120905060029081019190915554600885018054600090811015610002579081526020812090506001015560048401805461ff0019166101001790555b60088401805460009081101561000257906000526020600020906004020160005060010154600885018054600090811015610002579081526020812090505433600160a060020a031660009081526020819052604081205460088801805493909102939093049550908110156100025790815260208120905060030160009054906101000a9004600160a060020a0316600160a060020a031663baac530084336040518360e060020a0281526004018082600160a060020a0316815260200191505060206040518083038185886185025a03f115610002575050604051511515600014159150611ea0905057610002565b60088501805460009081101561000257818152602081206003018054600160a060020a03191690931790925580549091908110156100025790815260208120905060030154600160a060020a031660001415611e7f57610002565b60155430600160a060020a0316311015611e9857610002565b611cb361047c565b6008840180546000908110156100025781548282526020822060010154929190811015610002579081526020812090506002015433600160a060020a0390811660009081526020818152604080832054309094168352600d8083528184205460119093529083205460088b018054969095029690960497509487020494508593929091908290811015610002575260208120815060030154600160a060020a03908116825260208281019390935260409182016000908120805490950190945530168352600d90915290205482901015611f7957610002565b30600160a060020a03166000908152600d602052604081208054849003905560088501805483926011929091829081101561000257508152602080822060030154600160a060020a03908116835292905260408082208054909401909355309091168152205481901015611fec57610002565b30600160a060020a039081166000908152601160209081526040808320805486900390553390931680835282825283518484205481529351929390927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929181900390910190a361205c33610869565b505050600160a060020a0333166000908152602081815260408083208054600280549190910390558390556012909152812055506001949350505050565b33600160a060020a038181166000908152601160209081526040808320548151600e5460105460e060020a63d2cc718f028352935197995091969195929092169363d2cc718f936004848101949193929183900301908290876161da5a03f1156100025750505060405180519060200150600d600050600033600160a060020a03168152602001908152602001600020600050540204101561213b57610002565b600160a060020a033381166000908152601160209081526040808320548151600e5460105460e060020a63d2cc718f02835293519296909593169363d2cc718f93600483810194929383900301908290876161da5a03f1156100025750505060405180519060200150600d600050600033600160a060020a03168152602001908152602001600020600050540204039050831561228a57601060009054906101000a9004600160a060020a0316600160a060020a0316630221038a83600160a060020a0316630e7082036040518160e060020a0281526004018090506020604051808303816000876161da5a03f11561000257505060408051805160e160020a63011081c5028252600160a060020a031660048201526024810186905290516044808301935060209282900301816000876161da5a03f11561000257505060405151151590506122f257610002565b6040805160105460e160020a63011081c5028252600160a060020a038581166004840152602483018590529251921691630221038a9160448082019260209290919082900301816000876161da5a03f11561000257505060405151151590506122f257610002565b33600160a060020a0316600090815260116020526040902080548201905560019250610bb6565b155b801561232d575061232d338484611226565b801561234957506123498383600060003411156129f557610002565b15610bbd57506001610336565b6000141561236357610002565b600034111561237157610002565b60088054859081101561000257505050600160a060020a0333166000908152600e84027ff3f7a9fe364faab93b216da50a3214154f22a0a2b415b23a84c8169e8b636eee8101602052604090912054600080516020612a98833981519152919091019060ff16806123ee5750600c810160205260406000205460ff165b806123fd575060038101544210155b1561240757610002565b821561244b5733600160a060020a0316600090815260208181526040808320546009850180549091019055600b84019091529020805460ff19166001179055612485565b33600160a060020a031660009081526020818152604080832054600a850180549091019055600c84019091529020805460ff191660011790555b33600160a060020a031660009081526013602052604081205414156124b157604060002084905561252d565b33600160a060020a031660009081526013602052604090205460088054909190811015610002576000919091527ff3f7a9fe364faab93b216da50a3214154f22a0a2b415b23a84c8169e8b636ee6600e90910201546003820154111561252d5733600160a060020a031660009081526013602052604090208490555b604080518415158152905133600160a060020a03169186917f86abfce99b7dd908bec0169288797f85049ec73cbe046ed9de818fab3a497ae09181900360200190a35092915050565b61097f33610869565b151561258a57610002565b61125d848484610414565b30600160a060020a031633600160a060020a03161415806125da575030600160a060020a03166000908152600d60205260409020546064906125d561047c565b010481115b156125e457610002565b601455565b6008805487908110156100025790600052602060002090600e020160005090508484846040518084600160a060020a0316606060020a0281526014018381526020018280519060200190808383829060006004602084601f0104600302600f01f150905001935050505060405180910390206000191681600501600050546000191614915050949350505050565b506000610603565b60025460095481049290910160030290840204019050610603565b600160a060020a03831660009081526013602052604090205460088054909190811015610002576000918252600e02600080516020612a98833981519152019050600381015490915042111561270c57600160a060020a03831660009081526013602052604081208190559150612711565b600191505b50919050565b600160a060020a03861660009081526012602052604090205480850291909104915081111561274557610002565b600160a060020a038581166000908152601260205260408082208054859003905591861681522080548201905560019150509392505050565b600160a060020a0384166000908152602081905260409020548290108015906127c75750600160209081526040600081812033600160a060020a03168252909252902054829010155b80156127d35750600082115b1561285f57600160a060020a0383811660008181526020818152604080832080548801905588851680845281842080548990039055600183528184203390961684529482529182902080548790039055815186815291519293927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9281900390910190a3506001611260565b506000611260565b600160a060020a03838116600090815260126020908152604080832054600254600f54835160e060020a63d2cc718f02815293519296919591169363d2cc718f9360048181019492939183900301908290876161da5a03f1156100025750506040515190506128d5866105e9565b020410156128e257610002565b600160a060020a03838116600090815260126020908152604080832054600254600f54835160e060020a63d2cc718f02815293519296919591169363d2cc718f9360048181019492939183900301908290876161da5a03f115610002575050604051519050612950866105e9565b0204039050600f60009054906101000a9004600160a060020a0316600160a060020a0316630221038a84836040518360e060020a0281526004018083600160a060020a03168152602001828152602001925050506020604051808303816000876161da5a03f11561000257505060405151151590506129ce57610002565b600160a060020a038316600090815260126020526040902080548201905560019150612711565b33600160a060020a0316600090815260208190526040902054829010801590612a1e5750600082115b15612a9057600160a060020a0333811660008181526020818152604080832080548890039055938716808352918490208054870190558351868152935191937fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929081900390910190a3506001610336565b50600061033656f3f7a9fe364faab93b216da50a3214154f22a0a2b415b23a84c8169e8b636ee3",
    "updated_at": 1474998354996,
    "links": {},
    "events": {
      "0x5790de2c279e58269b93b12828f56fd5f2bc8ad15e61ce08572585c81a38756f": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "recipient",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "amount",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "newCurator",
            "type": "bool"
          },
          {
            "indexed": false,
            "name": "description",
            "type": "string"
          }
        ],
        "name": "ProposalAdded",
        "type": "event"
      },
      "0x86abfce99b7dd908bec0169288797f85049ec73cbe046ed9de818fab3a497ae0": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "position",
            "type": "bool"
          },
          {
            "indexed": true,
            "name": "voter",
            "type": "address"
          }
        ],
        "name": "Voted",
        "type": "event"
      },
      "0xdfc78bdca8e3e0b18c16c5c99323c6cb9eb5e00afde190b4e7273f5158702b07": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "proposalID",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "result",
            "type": "bool"
          },
          {
            "indexed": false,
            "name": "quorum",
            "type": "uint256"
          }
        ],
        "name": "ProposalTallied",
        "type": "event"
      },
      "0x9046fefd66f538ab35263248a44217dcb70e2eb2cd136629e141b8b8f9f03b60": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_newCurator",
            "type": "address"
          }
        ],
        "name": "NewCurator",
        "type": "event"
      },
      "0x73ad2a153c8b67991df9459024950b318a609782cee8c7eeda47b905f9baa91f": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_recipient",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_allowed",
            "type": "bool"
          }
        ],
        "name": "AllowedRecipientChanged",
        "type": "event"
      },
      "0xf381a3e2428fdda36615919e8d9c35878d9eb0cf85ac6edf575088e80e4c147e": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "FuelingToDate",
        "type": "event"
      },
      "0xdbccb92686efceafb9bb7e0394df7f58f71b954061b81afb57109bf247d3d75a": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "amount",
            "type": "uint256"
          }
        ],
        "name": "CreatedToken",
        "type": "event"
      },
      "0xbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "Refund",
        "type": "event"
      },
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_from",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_amount",
            "type": "uint256"
          }
        ],
        "name": "Transfer",
        "type": "event"
      },
      "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_owner",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_spender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_amount",
            "type": "uint256"
          }
        ],
        "name": "Approval",
        "type": "event"
      }
    }
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};
    this.events          = this.prototype.events          = network.events || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "function") {
      var contract = name;

      if (contract.address == null) {
        throw new Error("Cannot link contract without an address.");
      }

      Contract.link(contract.contract_name, contract.address);

      // Merge events so this contract knows about library's events
      Object.keys(contract.events).forEach(function(topic) {
        Contract.events[topic] = contract.events[topic];
      });

      return;
    }

    if (typeof name == "object") {
      var obj = name;
      Object.keys(obj).forEach(function(name) {
        var a = obj[name];
        Contract.link(name, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "DAO";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.2.0";

  // Allow people to opt-in to breaking changes now.
  Contract.next_gen = false;

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.DAO = Contract;
  }
})();
