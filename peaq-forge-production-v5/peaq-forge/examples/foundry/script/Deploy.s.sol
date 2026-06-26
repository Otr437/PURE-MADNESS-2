// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/PeaqCounter.sol";

/**
 * @notice Deploy PeaqCounter to peaq EVM via forge script.
 *
 * Usage:
 *   forge script script/Deploy.s.sol:DeployPeaqCounter \
 *     --rpc-url https://rpcpc1-qa.agung.peaq.network \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast
 *
 *   # Dry run (no broadcast):
 *   forge script script/Deploy.s.sol:DeployPeaqCounter \
 *     --rpc-url https://rpcpc1-qa.agung.peaq.network
 */
contract DeployPeaqCounter is Script {
    function run() external returns (PeaqCounter counter) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        console.log("Deployer:", deployer);
        console.log("Balance: ", deployer.balance);

        vm.startBroadcast(deployerKey);
        counter = new PeaqCounter();
        vm.stopBroadcast();

        console.log("PeaqCounter deployed at:", address(counter));
        console.log("Owner:", counter.owner());
    }
}
