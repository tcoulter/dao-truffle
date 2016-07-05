import "TokenInterface.sol";

contract Token is TokenInterface {
    // Protects users by preventing the execution of method calls that
    // inadvertently also transferred ether
    modifier noEther() {if (msg.value > 0) throw; _}

    function balanceOf(address _owner) constant returns (uint256 balance) {
        return balances[_owner];
    }

    function transfer(address _to, uint256 _amount) noEther returns (bool success) {
        if (balances[msg.sender] >= _amount && _amount > 0) {
            balances[msg.sender] -= _amount;
            balances[_to] += _amount;
            Transfer(msg.sender, _to, _amount);
            return true;
        } else {
           return false;
        }
    }

    function transferFrom(
        address _from,
        address _to,
        uint256 _amount
    ) noEther returns (bool success) {

        if (balances[_from] >= _amount
            && allowed[_from][msg.sender] >= _amount
            && _amount > 0) {

            balances[_to] += _amount;
            balances[_from] -= _amount;
            allowed[_from][msg.sender] -= _amount;
            Transfer(_from, _to, _amount);
            return true;
        } else {
            return false;
        }
    }

    function approve(address _spender, uint256 _amount) returns (bool success) {
        allowed[msg.sender][_spender] = _amount;
        Approval(msg.sender, _spender, _amount);
        return true;
    }

    function allowance(address _owner, address _spender) constant returns (uint256 remaining) {
        return allowed[_owner][_spender];
    }
}
