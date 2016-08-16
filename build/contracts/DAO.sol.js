var Web3 = require("web3");

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
    synchronizeFunction: function(fn, C) {
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
                  return accept(tx, receipt);
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
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], constructor);
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
      }
    ],
    "unlinked_binary": "0x606060405260405160c0806133558339610120604052905160805160a051925160e05161010051939492938282826000829055600183815560028054610100840261010060a860020a03199091161790556040513091906101be806103408339600160a060020a03909316908301526101408201526040519081900361016001906000f060038054600160a060020a031916919091179055505060088054600160a060020a03199081168917909155601380549091168717905550601184905560405130906000906101be806104fe8339018083600160a060020a03168152602001821515815260200192505050604051809103906000f0600c60006101000a815481600160a060020a03021916908302179055503060006040516101be806106bc8339018083600160a060020a03168152602001821515815260200192505050604051809103906000f0600d8054600160a060020a031916919091179055600c54600160a060020a03166000141561017757610002565b600d54600160a060020a03166000141561019057610002565b4260075560056006819055805460018083559190829080158290116101ce57600e0281600e0283600052602060002091820191016101ce9190610249565b50505030600160a060020a03908116600090815260096020526040808220805460ff19908116600190811790925560085490941683529120805490921617905550505050505050612adb8061087a6000396000f35b5050600060098201819055600a820155600d81018054600160a060020a0319169055600e015b8082111561033c578054600160a060020a03191681556000600182810182905560028381018054848255909281161561010002600019011604601f81901061030e57505b506000600383018190556004838101805461ffff19169055600584018290556006840182905560078401805460ff191690556008840180548382559083526020909220610223929091028101905b8082111561033c576000808255600182018190556002820155600381018054600160a060020a03191690556004016102db565b601f01602090049060005260206000209081019061028d91905b8082111561033c5760008155600101610328565b50905660606040818152806101be833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561016490819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100aa5780638da5cb5b146100be578063d2cc718f146100d0575b6100d96001805434019055565b6100db6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a05750805460a060020a900460ff1680156100a057508054600160a060020a03848116911614155b156100f957610002565b6100db60005460ff60a060020a9091041681565b6100ef600054600160a060020a031681565b6100ef60015481565b005b604080519115158252519081900360200190f35b6060908152602090f35b600160a060020a0383168260608381818185876185025a03f1925050501561015e57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a25060015b929150505660606040818152806101be833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561016490819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100aa5780638da5cb5b146100be578063d2cc718f146100d0575b6100d96001805434019055565b6100db6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a05750805460a060020a900460ff1680156100a057508054600160a060020a03848116911614155b156100f957610002565b6100db60005460ff60a060020a9091041681565b6100ef600054600160a060020a031681565b6100ef60015481565b005b604080519115158252519081900360200190f35b6060908152602090f35b600160a060020a0383168260608381818185876185025a03f1925050501561015e57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a25060015b929150505660606040818152806101be833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561016490819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100aa5780638da5cb5b146100be578063d2cc718f146100d0575b6100d96001805434019055565b6100db6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a05750805460a060020a900460ff1680156100a057508054600160a060020a03848116911614155b156100f957610002565b6100db60005460ff60a060020a9091041681565b6100ef600054600160a060020a031681565b6100ef60015481565b005b604080519115158252519081900360200190f35b6060908152602090f35b600160a060020a0383168260608381818185876185025a03f1925050501561015e57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a25060015b92915050566060604052361561020e5760e060020a6000350463013cf08b8114610245578063095ea7b3146102c55780630c3b7b961461033a5780630e70820314610343578063149acf9a1461035557806318160ddd146103675780631f2dc5ef1461037057806321b5b8dd14610390578063237e9492146103a257806323b872dd146104035780632632bf2014610435578063341458081461046657806339d1f9081461046f5780634b6753bc146104875780634df6d6cc146104905780634e10c3ee146104ab578063590e1ae3146104be578063612e45a3146104cf578063643f7cdd1461056e578063674ed066146105865780636837ff1e1461058f57806370a08231146105d9578063749f9889146105ff57806378524b2e1461061857806381f03fcb1461067257806382661dc41461068a57806382bf6464146106ab5780638b15a605146106bd5780638d7af473146106c657806396d7f3f5146106d5578063a1da2fb9146106de578063a3912ec8146106f8578063a9059cbb14610703578063b7bc2c8414610732578063baac53001461073e578063be7c29c1146107a0578063c9d27afe14610804578063cc9ae3f61461081a578063cdef91d01461082e578063dbde198814610846578063dd62ed3e1461086b578063e33734fd1461089f578063e5962195146108b3578063e66f53b7146108cb578063eceb2945146108dd578063f8c80d261461093c575b610953600080546234bc000142108015610237575060035433600160a060020a03908116911614155b156109675761096f33610745565b6109756004356005805482908110156100025790600052602060002090600e020160005060038101546004820154600683015460018401548454600786015460058701546009880154600a890154600d8a0154600160a060020a039586169b509599600201989760ff81811698610100909204811697949691951693168c565b61095360043560243533600160a060020a03908116600081815260156020908152604080832094871680845294825280832086905580518681529051929493927f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925929181900390910190a35060015b92915050565b610a7660015481565b610a88600c54600160a060020a031681565b610a88601354600160a060020a031681565b610a7660165481565b610a765b60004262127500600060005054031115610baf57506014610972565b610a88600354600160a060020a031681565b60408051602060248035600481810135601f81018590048502860185019096528585526109539581359591946044949293909201918190840183828082843750949650505050505050600060006000600060006000341115610c2c57610002565b6109536004356024356044355b60025460009060ff1680156104255750805442115b801561124657506112448461043f565b610953600061096f335b600160a060020a03811660009081526010602052604081205481908114156126c457610ba4565b610a76600b5481565b610a765b60125430600160a060020a03163103610972565b610a7660005481565b61095360043560096020526000908152604090205460ff1681565b610953600435602435600061129561081e565b610aa560003411156112b157610002565b604080516020604435600481810135601f8101849004840285018401909552848452610a76948135946024803595939460649492939101918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a01909352828252969897608497919650602491909101945090925082915084018382808284375094965050933593505060a435915050600060006114f2336105e0565b610a76600435600e6020526000908152604090205481565b610a7660065481565b610aa560043530600160a060020a031633600160a060020a03161415806105cf5750600160a060020a03811660009081526009602052604090205460ff16155b15611a3657611a33565b610a766004355b600160a060020a0381166000908152601460205260409020545b919050565b61095360043560243560006000341115611a6757610002565b610953600062e6b680420360076000505410806106445750600854600160a060020a0390811633909116145b80156106585750600754621274ff19420190105b15611ae45750426007556006805460020290556001610972565b610a76600435600f6020526000908152604090205481565b610953600435602435600060006000600060006000341115611aec57610002565b610a88600d54600160a060020a031681565b610a7660115481565b610a7660055460001901610972565b610a7660075481565b61095360043560006000600060003411156120b857610002565b6109535b6001610972565b6109536004356024355b60025460009060ff1680156107225750805442115b801561233a57506123383361043f565b61095360025460ff1681565b6109536004355b600080548190421080156107595750600034115b801561079357506002546101009004600160a060020a03166000148061079357506002546101009004600160a060020a0390811633909116145b15610baa57610aa7610374565b610a8860043560006005600050828154811015610002575081527f036b6384b5eca791c62761152d0c79bb0604c104a5fb6f4eb0703f3154bb3db8600e83020180548290811015610002575081526020902060030154600160a060020a03166105fa565b610a7660043560243560006000612375336105e0565b6109535b6000600034111561259957610002565b610a76600435600a6020526000908152604090205481565b61095360043560243560443560006125a2845b60006000600034111561288857610002565b610a76600435602435600160a060020a03828116600090815260156020908152604080832093851683529290522054610334565b610aa560043560003411156125b857610002565b610a7660043560106020526000908152604090205481565b610a88600854600160a060020a031681565b604080516020606435600481810135601f81018490048402850184019095528484526109539481359460248035956044359560849492019190819084018382808284375094965050505050505060006000600034111561260c57610002565b610a886002546101009004600160a060020a031681565b604080519115158252519081900360200190f35b61096f6106fc565b90505b90565b604051808d600160a060020a031681526020018c8152602001806020018b81526020018a15158152602001891515815260200188600019168152602001878152602001861515815260200185815260200184815260200183600160a060020a0316815260200182810382528c818154600181600116156101000203166002900481526020019150805460018160011615610100020316600290048015610a5c5780601f10610a3157610100808354040283529160200191610a5c565b820191906000526020600020905b815481529060010190602001808311610a3f57829003601f168201915b50509d505050505050505050505050505060405180910390f35b60408051918252519081900360200190f35b60408051600160a060020a03929092168252519081900360200190f35b005b604051600354601434908102939093049350600160a060020a03169183900390600081818185876185025a03f150505050600160a060020a038316600081815260146020908152604080832080548601905560168054860190556004825291829020805434019055815184815291517fdbccb92686efceafb9bb7e0394df7f58f71b954061b81afb57109bf247d3d75a9281900390910190a260015460165410801590610b57575060025460ff16155b15610b9f576002805460ff1916600117905560165460408051918252517ff381a3e2428fdda36615919e8d9c35878d9eb0cf85ac6edf575088e80e4c147e9181900360200190a15b600191505b50919050565b610002565b4262054600600060005054031115610bdd576201518062127500600060005054034203046014019050610972565b50601e610972565b60408051861515815260208101839052815189927fdfc78bdca8e3e0b18c16c5c99323c6cb9eb5e00afde190b4e7273f5158702b07928290030190a25b5050505092915050565b60058054889081101561000257506000527f036b6384b5eca791c62761152d0c79bb0604c104a5fb6f4eb0703f3154bb3db7600e880290810154600080516020612abb83398151915291909101945060ff16610c8b57620d2f00610c90565b622398805b600485015490935060ff168015610cac57506003840154830142115b15610cba57610d6487610e3c565b6003840154421080610cd15750600484015460ff16155b80610d5a57508360000160009054906101000a9004600160a060020a03168460010160005054876040518084600160a060020a0316606060020a0281526014018381526020018280519060200190808383829060006004602084601f0104600f02600301f150905001935050505060405180910390206000191684600501600050546000191614155b15610eae57610002565b610c22565b60048401805461ff001916610100179055835460019550600160a060020a039081163090911614801590610dad57508354600c54600160a060020a03908116911614155b8015610dc95750600d548454600160a060020a03908116911614155b8015610de557508354600354600160a060020a03908116911614155b8015610e0157508354600854600160a060020a03908116911614155b15610e375760018401805430600160a060020a03166000908152600a60205260409020805491909101905554600b805490910190555b610be5875b60006005600050828154811015610002579152600e027f036b6384b5eca791c62761152d0c79bb0604c104a5fb6f4eb0703f3154bb3db4810154600080516020612abb833981519152919091019060ff1615610ea057601280546006830154900390555b600401805460ff1916905550565b8354610f6090600160a060020a03165b600160a060020a03811660009081526009602052604081205460ff1680610f535750600354600160a060020a03908116908316148015610f535750600360009054906101000a9004600160a060020a0316600160a060020a031663d2cc718f6040518160e060020a0281526004018090506020604051808303816000876161da5a03f11561000257505060405151600b541190505b1561269a575060016105fa565b1515610f6f57610f7b87610e3c565b60019150610fac610473565b604051600d8501546006860154600160a060020a0391909116916000919082818181858883f1935050505050610c22565b60018501541115610fbc57600091505b50600a830154600984015486519101906004901080159061100b575085600081518110156100025790602001015160f860020a900460f860020a02600160f860020a031916606860f860020a02145b8015611045575085600181518110156100025790602001015160f860020a900460f860020a02600160f860020a031916603760f860020a02145b801561107f575085600281518110156100025790602001015160f860020a900460f860020a02600160f860020a03191660ff60f860020a02145b80156110b9575085600381518110156100025790602001015160f860020a900460f860020a02600160f860020a031916601e60f860020a02145b80156110e8575030600160a060020a03166000908152600a60205260409020546110e590611100610473565b81105b156110f257600091505b600184015461112390611102565b015b30600160a060020a03166000908152600a60205260408120546126a2610473565b811061117757604051600d8501546006860154600160a060020a0391909116916000919082818181858883f19350505050151561115f57610002565b42600755601654600590048111156111775760056006555b600184015461118590611102565b811015801561119b5750600a8401546009850154115b80156111a45750815b15610e37578360000160009054906101000a9004600160a060020a0316600160a060020a0316846001016000505487604051808280519060200190808383829060006004602084601f0104600f02600301f150905090810190601f1680156112205780820380516001836020036101000a031916815260200191505b5091505060006040518083038185876185025a03f1925050501515610d6957610002565b155b801561126157506112618484845b60006000612736856105e0565b801561127e575061127e8484846000600034111561279d57610002565b15610baa5750600161128e565b90505b9392505050565b15156112a057610002565b6112aa838361070d565b9050610334565b600054421180156112c5575060025460ff16155b156114f057600360009054906101000a9004600160a060020a0316600160a060020a031663d2cc718f6040518160e060020a0281526004018090506020604051808303816000876161da5a03f1156100025750506040516003549051600160a060020a0391909116311090506113d6576040805160035460e060020a63d2cc718f0282529151600160a060020a039290921691630221038a913091849163d2cc718f91600482810192602092919082900301816000876161da5a03f11561000257505060408051805160e160020a63011081c5028252600160a060020a039490941660048201526024810193909352516044838101936020935082900301816000876161da5a03f115610002575050505b33600160a060020a0316600081815260046020526040808220549051909181818185876185025a03f192505050156114f05733600160a060020a03167fbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d6004600050600033600160a060020a03168152602001908152602001600020600050546040518082815260200191505060405180910390a26014600050600033600160a060020a0316815260200190815260200160002060005054601660008282825054039250508190555060006014600050600033600160a060020a031681526020019081526020016000206000508190555060006004600050600033600160a060020a03168152602001908152602001600020600050819055505b565b600014156114ff57610002565b828015611549575086600014158061151957508451600014155b806115315750600854600160a060020a038981169116145b8061153c5750600034115b80611549575062093a8084105b1561155357610002565b82158015611573575061156588610ebe565b158061157357506212750084105b1561157d57610002565b6249d40084111561158d57610002565b60025460ff1615806115a0575060005442105b806115b55750601154341080156115b5575082155b156115bf57610002565b4284420110156115ce57610002565b30600160a060020a031633600160a060020a031614156115ed57610002565b600580546001810180835590919082801582901161162457600e0281600e02836000526020600020918201910161162491906116e0565b505060058054929450918491508110156100025790600052602060002090600e02016000508054600160a060020a031916891781556001818101899055875160028381018054600082815260209081902096975091959481161561010002600019011691909104601f908101829004840193918b01908390106117d757805160ff19168380011785555b506118079291506117bf565b5050600060098201819055600a820155600d81018054600160a060020a0319169055600e015b808211156117d3578054600160a060020a03191681556000600182810182905560028381018054848255909281161561010002600019011604601f8190106117a557505b506000600383018190556004838101805461ffff19169055600584018290556006840182905560078401805460ff1916905560088401805483825590835260209092206116ba929091028101905b808211156117d3576000808255600182018190556002820155600381018054600160a060020a0319169055600401611772565b601f01602090049060005260206000209081019061172491905b808211156117d357600081556001016117bf565b5090565b828001600101855582156116ae579182015b828111156116ae5782518260005055916020019190600101906117e9565b50508787866040518084600160a060020a0316606060020a0281526014018381526020018280519060200190808383829060006004602084601f0104600f02600301f150905001935050505060405180910390208160050160005081905550834201816003016000508190555060018160040160006101000a81548160ff02191690830217905550828160070160006101000a81548160ff0219169083021790555082156118ed57600881018054600181018083559091908280158290116118e8576004028160040283600052602060002091820191016118e89190611772565b505050505b600d81018054600160a060020a03191633179055346006820181905560128054909101905560408051600160a060020a038a16815260208181018a905285151592820192909252608060608201818152895191830191909152885185937f5790de2c279e58269b93b12828f56fd5f2bc8ad15e61ce08572585c81a38756f938d938d938a938e93929160a084019185810191908190849082908590600090600490601f850104600f02600301f150905090810190601f1680156119c45780820380516001836020036101000a031916815260200191505b509550505050505060405180910390a2509695505050505050565b30600160a060020a039081166000818152600a6020908152604080832080549587168085528285208054909701909655848452839055600e9091528082208054948352908220805490940190935590815290555b50565b604051600160a060020a0382811691309091163190600081818185876185025a03f19250505015156119df57610002565b600854600160a060020a039081163390911614611a8357610002565b600160a060020a038316600081815260096020908152604091829020805460ff1916861790558151851515815291517f73ad2a153c8b67991df9459024950b318a609782cee8c7eeda47b905f9baa91f9281900390910190a2506001610334565b506000610972565b611af5336105e0565b60001415611b0257610002565b6005805488908110156100025750600052600e87027f036b6384b5eca791c62761152d0c79bb0604c104a5fb6f4eb0703f3154bb3db3810154600080516020612abb833981519152919091019450421080611b6557506003840154622398800142115b80611b7e57508354600160a060020a0390811690871614155b80611b8e5750600784015460ff16155b80611bb4575033600160a060020a03166000908152600b8501602052604090205460ff16155b80611be8575033600160a060020a03166000908152601060205260409020548714801590611be85750604060009081205414155b15611bf257610002565b600884018054600090811015610002579081526020812060030154600160a060020a03161415611d5e57611e4186604051600090600160a060020a038316907f9046fefd66f538ab35263248a44217dcb70e2eb2cd136629e141b8b8f9f03b60908390a2604080516013547fe2faf044000000000000000000000000000000000000000000000000000000008252600160a060020a03858116600484015260248301859052604483018590526223988042016064840152925192169163e2faf04491608480820192602092909190829003018187876161da5a03f1156100025750506040515191506105fa9050565b6008850180546000908110156100025781815260208082209390935530600160a060020a03168152600a909252604082205481549092908110156100025790815260208120905060020155601654600885018054600090811015610002579081526020812090506001015560048401805461ff0019166101001790555b6008840180546000908110156100025781548282526020822060010154929190811015610002579081526020812090505433600160a060020a031660009081526014602052604081205460088801805493909102939093049550908110156100025790815260208120905060030160009054906101000a9004600160a060020a0316600160a060020a031663baac530084336040518360e060020a0281526004018082600160a060020a0316815260200191505060206040518083038185886185025a03f115610002575050604051511515600014159150611ebd905057610002565b60088501805460009081101561000257818152602081206003018054600160a060020a03191690931790925580549091908110156100025790815260208120905060030154600160a060020a031660001415611e9c57610002565b60125430600160a060020a0316311015611eb557610002565b611ce1610473565b6008840180546000908110156100025781548282526020822060010154929190811015610002579081526020812090506002015433600160a060020a03908116600090815260146020908152604080832054309094168352600a80835281842054600e9093529083205460088b018054969095029690960497509487020494508593929091908290811015610002575260208120815060030154600160a060020a03908116825260208281019390935260409182016000908120805490950190945530168352600a90915290205482901015611f9857610002565b30600160a060020a03166000908152600a60205260408120805484900390556008850180548392600e929091829081101561000257508152602080822060030154600160a060020a0390811683529290526040808220805490940190935530909116815220548190101561200b57610002565b30600160a060020a039081166000908152600e6020908152604080832080548690039055339093168083526014825283518484205481529351929390927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929181900390910190a361207c33610859565b5033600160a060020a03166000908152601460209081526040808320805460168054919091039055839055600f90915281205560019450610c22565b33600160a060020a038181166000908152600e60209081526040808320548151600b54600d5460e060020a63d2cc718f028352935197995091969195929092169363d2cc718f936004848101949193929183900301908290876161da5a03f1156100025750505060405180519060200150600a600050600033600160a060020a03168152602001908152602001600020600050540204101561215957610002565b600160a060020a033381166000908152600e60209081526040808320548151600b54600d5460e060020a63d2cc718f02835293519296909593169363d2cc718f93600483810194929383900301908290876161da5a03f1156100025750505060405180519060200150600a600050600033600160a060020a0316815260200190815260200160002060005054020403905083156122a857600d60009054906101000a9004600160a060020a0316600160a060020a0316630221038a83600160a060020a0316630e7082036040518160e060020a0281526004018090506020604051808303816000876161da5a03f11561000257505060408051805160e160020a63011081c5028252600160a060020a031660048201526024810186905290516044808301935060209282900301816000876161da5a03f115610002575050604051511515905061231057610002565b60408051600d5460e160020a63011081c5028252600160a060020a038581166004840152602483018590529251921691630221038a9160448082019260209290919082900301816000876161da5a03f115610002575050604051511515905061231057610002565b600160a060020a0333166000908152600e602052604090208054909101905550600192915050565b155b801561234c575061234c338484611254565b80156123685750612368838360006000341115612a1657610002565b15610baa57506001610334565b6000141561238257610002565b600034111561239057610002565b60058054859081101561000257505050600160a060020a0333166000908152600e84027f036b6384b5eca791c62761152d0c79bb0604c104a5fb6f4eb0703f3154bb3dbb8101602052604090912054600080516020612abb833981519152919091019060ff168061240d5750600c810160205260406000205460ff165b8061241c575060038101544210155b1561242657610002565b821561246c5733600160a060020a03166000908152601460209081526040808320546009850180549091019055600b84019091529020805460ff191660011790556124a8565b33600160a060020a0316600090815260146020908152604080832054600a850180549091019055600c84019091529020805460ff191660011790555b33600160a060020a031660009081526010602052604081205414156124d4576040600020849055612550565b33600160a060020a031660009081526010602052604090205460058054909190811015610002576000919091527f036b6384b5eca791c62761152d0c79bb0604c104a5fb6f4eb0703f3154bb3db3600e9091020154600382015411156125505733600160a060020a031660009081526010602052604090208490555b604080518415158152905133600160a060020a03169186917f86abfce99b7dd908bec0169288797f85049ec73cbe046ed9de818fab3a497ae09181900360200190a35092915050565b61096f33610859565b15156125ad57610002565b61128b848484610410565b30600160a060020a031633600160a060020a03161415806125fd575030600160a060020a03166000908152600a60205260409020546064906125f8610473565b010481115b1561260757610002565b601155565b6005805487908110156100025790600052602060002090600e020160005090508484846040518084600160a060020a0316606060020a0281526014018381526020018280519060200190808383829060006004602084601f0104600f02600301f150905001935050505060405180910390206000191681600501600050546000191614915050949350505050565b5060006105fa565b01600302601660005054830204600660005054601660005054040190506105fa565b600160a060020a03831660009081526010602052604090205460058054909190811015610002576000918252600e02600080516020612abb8339815191520190506003810154909150421115610b9f57600160a060020a03831660009081526010602052604081208190559150610ba4565b600160a060020a0386166000908152600f602052604090205480850291909104915081111561276457610002565b600160a060020a038581166000908152600f60205260408082208054859003905591861681522080548201905560019150509392505050565b600160a060020a0384166000908152601460205260409020548290108015906127e65750601560209081526040600081812033600160a060020a03168252909252902054829010155b80156127f25750600082115b1561288057600160a060020a03838116600081815260146020908152604080832080548801905588851680845281842080548990039055601583528184203390961684529482529182902080548790039055815186815291519293927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9281900390910190a350600161128e565b50600061128e565b600160a060020a038381166000908152600f6020908152604080832054601654600c54835160e060020a63d2cc718f02815293519296919591169363d2cc718f9360048181019492939183900301908290876161da5a03f1156100025750506040515190506128f6866105e0565b0204101561290357610002565b600160a060020a038381166000908152600f6020908152604080832054601654600c54835160e060020a63d2cc718f02815293519296919591169363d2cc718f9360048181019492939183900301908290876161da5a03f115610002575050604051519050612971866105e0565b0204039050600c60009054906101000a9004600160a060020a0316600160a060020a0316630221038a84836040518360e060020a0281526004018083600160a060020a03168152602001828152602001925050506020604051808303816000876161da5a03f11561000257505060405151151590506129ef57610002565b600160a060020a0383166000908152600f6020526040902080548201905560019150610ba4565b33600160a060020a0316600090815260146020526040902054829010801590612a3f5750600082115b15612ab357600160a060020a03338116600081815260146020908152604080832080548890039055938716808352918490208054870190558351868152935191937fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929081900390910190a3506001610334565b50600061033456036b6384b5eca791c62761152d0c79bb0604c104a5fb6f4eb0703f3154bb3db0",
    "updated_at": 1471380606703,
    "links": {}
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

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "object") {
      Object.keys(name).forEach(function(n) {
        var a = name[n];
        Contract.link(n, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "DAO";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.1.2";

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
