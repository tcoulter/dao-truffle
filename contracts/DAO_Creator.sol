import "DAO.sol";

contract DAO_Creator {
    function createDAO(
        address _curator,
        uint _proposalDeposit,
        uint _minTokensToCreate,
        uint _closingTime
    ) returns (DAO _newDAO) {

        return new DAO(
            _curator,
            DAO_Creator(this),
            _proposalDeposit,
            _minTokensToCreate,
            _closingTime,
            msg.sender
        );
    }
}
