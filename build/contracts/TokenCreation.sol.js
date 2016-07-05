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

                attempts += 1;

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
      throw new Error("TokenCreation error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.binary) {
      throw new Error("TokenCreation error: contract binary not set. Can't deploy new instance.");
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

      throw new Error("TokenCreation contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of TokenCreation: " + unlinked_libraries);
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
      throw new Error("Invalid address passed to TokenCreation.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: TokenCreation not deployed or address not set.");
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
            "name": "_from",
            "type": "address"
          },
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_amount",
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
        "constant": false,
        "inputs": [],
        "name": "refund",
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
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_amount",
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
    "binary": "6060604052604051606080610a5c83395060c06040525160805160a0516000829055600183815560028054610100840261010060a860020a0319909116179055309060c06101be806100948339600160a060020a039093169083015260e08201526040519081900361010001906000f060038054600160a060020a03191691909117905550505061080a806102526000396000f360606040818152806101be833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561016490819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100aa5780638da5cb5b146100be578063d2cc718f146100d0575b6100d96001805434019055565b6100db6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a05750805460a060020a900460ff1680156100a057508054600160a060020a03848116911614155b156100f957610002565b6100db60005460ff60a060020a9091041681565b6100ef600054600160a060020a031681565b6100ef60015481565b005b604080519115158252519081900360200190f35b6060908152602090f35b600160a060020a0383168260608381818185876185025a03f1925050501561015e57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a25060015b9291505056606060405236156100ae5760e060020a6000350463095ea7b381146100b05780630c3b7b961461012557806318160ddd1461012e5780631f2dc5ef1461013757806321b5b8dd1461015757806323b872dd146101695780634b6753bc14610185578063590e1ae31461018e57806370a082311461019f578063a9059cbb146101cd578063b7bc2c84146101e6578063baac5300146101f2578063dd62ed3e14610252578063f8c80d2614610286575b005b61029e60043560243533600160a060020a03908116600081815260066020908152604080832094871680845294825280832086905580518681529051929493927f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925929181900390910190a35060015b92915050565b6101bb60015481565b6101bb60075481565b6101bb5b600042621275006000600050540311156102cf57506014610301565b6102b2600354600160a060020a031681565b61029e6004356024356044356000600034111561030457610002565b6101bb60005481565b6100ae60003411156103f257610002565b600435600160a060020a03166000908152600560205260409020545b60408051918252519081900360200190f35b61029e6004356024356000600034111561065b57610002565b61029e60025460ff1681565b61029e6004356000805481904210801561020c5750600034115b801561024557506002546101009004600160a060020a031660001480610245575060025433600160a060020a0390811661010090920416145b156107015761070661013b565b6101bb600435602435600160a060020a0382811660009081526006602090815260408083209385168352929052205461011f565b6102b2600254600160a060020a036101009091041681565b604080519115158252519081900360200190f35b60408051600160a060020a03929092168252519081900360200190f35b42620546006000600050540311156102fd576201518062127500600060005054034203046014019050610301565b50601e5b90565b600160a060020a03841660009081526005602052604090205482901080159061034d5750600660209081526040600081812033600160a060020a03168252909252902054829010155b80156103595750600082115b156103e757600160a060020a03838116600081815260056020908152604080832080548801905588851680845281842080548990039055600683528184203390961684529482529182902080548790039055815186815291519293927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9281900390910190a35060016103eb565b5060005b9392505050565b60005442118015610406575060025460ff16155b1561065957600360009054906101000a9004600160a060020a0316600160a060020a031663d2cc718f6040518160e060020a0281526004018090506020604051808303816000876161da5a03f11561000257505060405151600354600160a060020a03163110905061053f57604080516003547fd2cc718f0000000000000000000000000000000000000000000000000000000082529151600160a060020a039290921691630221038a913091849163d2cc718f91600482810192602092919082900301816000876161da5a03f1156100025750506040805180517f0221038a000000000000000000000000000000000000000000000000000000008252600160a060020a039490941660048201526024810193909352516044838101936020935082900301816000876161da5a03f115610002575050505b33600160a060020a0316600081815260046020526040808220549051909181818185876185025a03f192505050156106595733600160a060020a03167fbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d6004600050600033600160a060020a03168152602001908152602001600020600050546040518082815260200191505060405180910390a26005600050600033600160a060020a0316815260200190815260200160002060005054600760008282825054039250508190555060006005600050600033600160a060020a031681526020019081526020016000206000508190555060006004600050600033600160a060020a03168152602001908152602001600020600050819055505b565b33600160a060020a03166000908152600560205260409020548290108015906106845750600082115b156106f95733600160a060020a03908116600081815260056020908152604080832080548890039055938716808352918490208054870190558351868152935191937fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929081900390910190a350600161011f565b50600061011f565b610002565b600354604051601434908102939093049350600160a060020a03919091169183900390600081818185876185025a03f150505050600160a060020a038316600081815260056020908152604080832080548601905560078054860190556004825291829020805434019055815184815291517fdbccb92686efceafb9bb7e0394df7f58f71b954061b81afb57109bf247d3d75a9281900390910190a2600154600754108015906107b9575060025460ff16155b15610801576002805460ff1916600117905560075460408051918252517ff381a3e2428fdda36615919e8d9c35878d9eb0cf85ac6edf575088e80e4c147e9181900360200190a15b5060019291505056",
    "unlinked_binary": "6060604052604051606080610a5c83395060c06040525160805160a0516000829055600183815560028054610100840261010060a860020a0319909116179055309060c06101be806100948339600160a060020a039093169083015260e08201526040519081900361010001906000f060038054600160a060020a03191691909117905550505061080a806102526000396000f360606040818152806101be833960a090525160805160008054600160a060020a03191690921760a060020a60ff0219167401000000000000000000000000000000000000000090910217815561016490819061005a90396000f3606060405236156100405760e060020a60003504630221038a811461004d57806318bdc79a146100aa5780638da5cb5b146100be578063d2cc718f146100d0575b6100d96001805434019055565b6100db6004356024356000805433600160a060020a0390811691161415806100755750600034115b806100a05750805460a060020a900460ff1680156100a057508054600160a060020a03848116911614155b156100f957610002565b6100db60005460ff60a060020a9091041681565b6100ef600054600160a060020a031681565b6100ef60015481565b005b604080519115158252519081900360200190f35b6060908152602090f35b600160a060020a0383168260608381818185876185025a03f1925050501561015e57604080518381529051600160a060020a038516917f9735b0cb909f3d21d5c16bbcccd272d85fa11446f6d679f6ecb170d2dabfecfc919081900360200190a25060015b9291505056606060405236156100ae5760e060020a6000350463095ea7b381146100b05780630c3b7b961461012557806318160ddd1461012e5780631f2dc5ef1461013757806321b5b8dd1461015757806323b872dd146101695780634b6753bc14610185578063590e1ae31461018e57806370a082311461019f578063a9059cbb146101cd578063b7bc2c84146101e6578063baac5300146101f2578063dd62ed3e14610252578063f8c80d2614610286575b005b61029e60043560243533600160a060020a03908116600081815260066020908152604080832094871680845294825280832086905580518681529051929493927f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925929181900390910190a35060015b92915050565b6101bb60015481565b6101bb60075481565b6101bb5b600042621275006000600050540311156102cf57506014610301565b6102b2600354600160a060020a031681565b61029e6004356024356044356000600034111561030457610002565b6101bb60005481565b6100ae60003411156103f257610002565b600435600160a060020a03166000908152600560205260409020545b60408051918252519081900360200190f35b61029e6004356024356000600034111561065b57610002565b61029e60025460ff1681565b61029e6004356000805481904210801561020c5750600034115b801561024557506002546101009004600160a060020a031660001480610245575060025433600160a060020a0390811661010090920416145b156107015761070661013b565b6101bb600435602435600160a060020a0382811660009081526006602090815260408083209385168352929052205461011f565b6102b2600254600160a060020a036101009091041681565b604080519115158252519081900360200190f35b60408051600160a060020a03929092168252519081900360200190f35b42620546006000600050540311156102fd576201518062127500600060005054034203046014019050610301565b50601e5b90565b600160a060020a03841660009081526005602052604090205482901080159061034d5750600660209081526040600081812033600160a060020a03168252909252902054829010155b80156103595750600082115b156103e757600160a060020a03838116600081815260056020908152604080832080548801905588851680845281842080548990039055600683528184203390961684529482529182902080548790039055815186815291519293927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9281900390910190a35060016103eb565b5060005b9392505050565b60005442118015610406575060025460ff16155b1561065957600360009054906101000a9004600160a060020a0316600160a060020a031663d2cc718f6040518160e060020a0281526004018090506020604051808303816000876161da5a03f11561000257505060405151600354600160a060020a03163110905061053f57604080516003547fd2cc718f0000000000000000000000000000000000000000000000000000000082529151600160a060020a039290921691630221038a913091849163d2cc718f91600482810192602092919082900301816000876161da5a03f1156100025750506040805180517f0221038a000000000000000000000000000000000000000000000000000000008252600160a060020a039490941660048201526024810193909352516044838101936020935082900301816000876161da5a03f115610002575050505b33600160a060020a0316600081815260046020526040808220549051909181818185876185025a03f192505050156106595733600160a060020a03167fbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d6004600050600033600160a060020a03168152602001908152602001600020600050546040518082815260200191505060405180910390a26005600050600033600160a060020a0316815260200190815260200160002060005054600760008282825054039250508190555060006005600050600033600160a060020a031681526020019081526020016000206000508190555060006004600050600033600160a060020a03168152602001908152602001600020600050819055505b565b33600160a060020a03166000908152600560205260409020548290108015906106845750600082115b156106f95733600160a060020a03908116600081815260056020908152604080832080548890039055938716808352918490208054870190558351868152935191937fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929081900390910190a350600161011f565b50600061011f565b610002565b600354604051601434908102939093049350600160a060020a03919091169183900390600081818185876185025a03f150505050600160a060020a038316600081815260056020908152604080832080548601905560078054860190556004825291829020805434019055815184815291517fdbccb92686efceafb9bb7e0394df7f58f71b954061b81afb57109bf247d3d75a9281900390910190a2600154600754108015906107b9575060025460ff16155b15610801576002805460ff1916600117905560075460408051918252517ff381a3e2428fdda36615919e8d9c35878d9eb0cf85ac6edf575088e80e4c147e9181900360200190a15b5060019291505056",
    "updated_at": 1467656954060
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
    this.binary          = this.prototype.binary          = network.binary;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;

    if (this.unlinked_binary == null || this.unlinked_binary == "") {
      this.unlinked_binary = this.prototype.unlinked_binary = this.binary;
    }

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "TokenCreation";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.0.3";

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.TokenCreation = Contract;
  }
})();
