# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

This is the **fakeroku** adapter, which emulates Roku devices to enable integration with Logitech Harmony Hubs. The adapter creates virtual Roku devices that can be discovered and controlled by Harmony Hubs, allowing ioBroker to respond to Harmony Hub commands as if it were a real Roku device.

## Adapter-Specific Context

- **Adapter Name:** fakeroku
- **Primary Function:** Emulates Roku devices for Logitech Harmony Hub integration
- **Key Dependencies:** 
  - `http-headers` for HTTP response handling
  - `@iobroker/adapter-core` for ioBroker integration
  - UDP multicast for device discovery (SSDP protocol)
- **Configuration Requirements:**
  - LAN IP address (not 0.0.0.0)
  - Multicast IP (default: 239.255.255.250)
  - Virtual Roku devices configuration (name, port, UUID)
- **Network Protocols:**
  - HTTP server for command reception
  - UDP multicast for SSDP device discovery
  - ECP (External Control Protocol) for Roku command handling

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files to allow testing of functionality without live connections
- Example test structure:
  ```javascript
  describe('AdapterName', () => {
    let adapter;
    
    beforeEach(() => {
      // Setup test adapter instance
    });
    
    test('should initialize correctly', () => {
      // Test adapter initialization
    });
  });
  ```

### Integration Testing

**IMPORTANT**: Use the official `@iobroker/testing` framework for all integration tests. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation**: https://github.com/ioBroker/testing

#### Framework Structure
Integration tests MUST follow this exact pattern:

```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

// Define test coordinates or configuration
const TEST_COORDINATES = '52.520008,13.404954'; // Berlin
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Use tests.integration() with defineAdditionalTests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it('should configure and start adapter', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        harness = getHarness();
                        
                        // Get adapter object using promisified pattern
                        const obj = await new Promise((res, rej) => {
                            harness.objects.getObject('system.adapter.your-adapter.0', (err, o) => {
                                if (err) return rej(err);
                                res(o);
                            });
                        });
                        
                        if (!obj) {
                            return reject(new Error('Adapter object not found'));
                        }

                        // Configure adapter properties
                        Object.assign(obj.native, {
                            position: TEST_COORDINATES,
                            createCurrently: true,
                            createHourly: true,
                            createDaily: true,
                            // Add other configuration as needed
                        });

                        // Set the updated configuration
                        harness.objects.setObject(obj._id, obj);

                        console.log('✅ Step 1: Configuration written, starting adapter...');
                        
                        // Start adapter and wait
                        await harness.startAdapterAndWait();
                        
                        console.log('✅ Step 2: Adapter started');

                        // Wait for adapter to process data
                        const waitMs = 15000;
                        await wait(waitMs);

                        console.log('🔍 Step 3: Checking states after adapter run...');
                        
                        // Get state values using callback-based methods
                        const stateIds = await new Promise((res, rej) => {
                            harness.states.getKeys('your-adapter.0.*', (err, keys) => {
                                if (err) return rej(err);
                                res(keys || []);
                            });
                        });

                        console.log(`Found ${stateIds.length} states`);
                        
                        // Check specific states
                        const connectionState = await new Promise((res, rej) => {
                            harness.states.getState('your-adapter.0.info.connection', (err, state) => {
                                if (err) return rej(err);
                                res(state);
                            });
                        });

                        if (!connectionState || !connectionState.val) {
                            return reject(new Error('Adapter connection state is false or missing'));
                        }

                        console.log('✅ Step 4: All integration tests passed');
                        resolve();
                        
                    } catch (error) {
                        console.error('❌ Integration test failed:', error.message);
                        reject(error);
                    }
                });
            });
        });
    }
});
```

#### For Adapters with Network Discovery (like fakeroku)

For network-dependent adapters, create mock environments:

```javascript
const mockUdpServer = require('dgram').createSocket('udp4');
const mockHttpServer = require('http').createServer();

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Network Discovery Tests', (getHarness) => {
            let harness;
            let mockServer;

            before(async () => {
                harness = getHarness();
                // Setup mock network services
                mockServer = mockHttpServer.listen(9093);
            });

            after(async () => {
                if (mockServer) {
                    mockServer.close();
                }
            });

            it('should handle network device discovery', async function() {
                this.timeout(30000);
                
                await harness.changeAdapterConfig('fakeroku', {
                    native: {
                        BIND: '0.0.0.0',
                        MULTICAST_IP: '239.255.255.250',
                        devices: [{
                            name: 'Test Roku',
                            port: 9093,
                            uuid: 'test-uuid-12345'
                        }]
                    }
                });

                await harness.startAdapter();
                await new Promise(resolve => setTimeout(resolve, 10000));

                // Verify adapter started and created device states
                const deviceStates = await new Promise((resolve, reject) => {
                    harness.states.getKeys('fakeroku.0.*', (err, keys) => {
                        if (err) return reject(err);
                        resolve(keys || []);
                    });
                });

                expect(deviceStates.length).toBeGreaterThan(0);
            });
        });
    }
});
```

**Critical Testing Patterns for Fakeroku:**
- Mock Harmony Hub discovery requests
- Test SSDP multicast responses
- Verify ECP command handling
- Test multiple device emulation
- Validate state creation for received commands

#### Avoid Common Testing Mistakes
- ❌ Don't use `adapter.startAdapterAndWait()` - use `harness.startAdapterAndWait()`
- ❌ Don't access private adapter properties directly
- ❌ Don't use setTimeout without proper cleanup
- ❌ Don't test against real Harmony Hubs in CI
- ✅ Always use the harness object for all ioBroker interactions
- ✅ Mock external network dependencies
- ✅ Test state creation and updates through the harness
- ✅ Use appropriate timeouts for network operations

## Development Guidelines

### Core Patterns for ioBroker Adapters

When suggesting code for ioBroker adapters, always follow these patterns:

#### Adapter Class Structure
```javascript
class YourAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            name: 'your-adapter',
            ...options,
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        // Initialize adapter
        this.setState('info.connection', false, true);
        await this.initializeAdapter();
    }

    onStateChange(id, state) {
        if (state && !state.ack) {
            // Handle state changes
        }
    }

    onUnload(callback) {
        try {
            // Cleanup resources
            callback();
        } catch (e) {
            callback();
        }
    }
}
```

#### State Management
- Always use `this.setState()` for state updates
- Set `ack: true` for values read from external systems
- Set `ack: false` for commands to be sent to external systems
- Create states with proper type definitions:

```javascript
await this.setObjectNotExistsAsync('device.status', {
    type: 'state',
    common: {
        name: 'Device Status',
        type: 'boolean',
        role: 'indicator.connected',
        read: true,
        write: false,
    },
    native: {},
});
```

#### Logging Best Practices
- Use appropriate log levels: `this.log.error()`, `this.log.warn()`, `this.log.info()`, `this.log.debug()`
- Always log important events and errors
- Use debug level for verbose operational details
- Include context in log messages

#### Error Handling
- Wrap async operations in try-catch blocks
- Always handle Promise rejections
- Use `this.log.error()` for error logging
- Gracefully degrade functionality when possible

### Network Service Development (Fakeroku-Specific)

#### HTTP Server Setup
```javascript
const http = require('http');

class FakerokuAdapter extends utils.Adapter {
    constructor(options = {}) {
        super(options);
        this.httpServers = new Map();
    }

    async createHttpServer(device) {
        const server = http.createServer((req, res) => {
            this.handleHttpRequest(req, res, device);
        });
        
        server.listen(device.port, this.config.BIND, () => {
            this.log.info(`HTTP server for ${device.name} listening on port ${device.port}`);
        });
        
        this.httpServers.set(device.name, server);
        return server;
    }

    handleHttpRequest(req, res, device) {
        const url = req.url;
        this.log.debug(`Received request: ${req.method} ${url} for device ${device.name}`);
        
        if (url.startsWith('/keypress/')) {
            const key = url.substring(10);
            this.createKeyState(device, key);
            res.writeHead(200);
            res.end();
        } else if (url === '/query/device-info') {
            this.sendDeviceInfo(res, device);
        }
    }
}
```

#### UDP Multicast for Device Discovery
```javascript
const dgram = require('dgram');

async setupSSDP() {
    this.ssdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    
    this.ssdpSocket.on('message', (message, remote) => {
        const msg = message.toString();
        if (msg.includes('M-SEARCH') && msg.includes('roku:ecp')) {
            this.respondToSSDP(remote);
        }
    });
    
    this.ssdpSocket.bind(1900, () => {
        this.ssdpSocket.addMembership('239.255.255.250');
        this.log.info('SSDP server bound to multicast group');
    });
}
```

#### State Creation for Commands
```javascript
async createKeyState(device, key) {
    const stateId = `${device.name}.${key}`;
    
    await this.setObjectNotExistsAsync(stateId, {
        type: 'state',
        common: {
            name: `Key: ${key}`,
            type: 'boolean',
            role: 'button',
            read: true,
            write: true,
        },
        native: {
            device: device.name,
            key: key
        },
    });
    
    await this.setStateAsync(stateId, { val: true, ack: true });
    
    // Reset after short delay
    setTimeout(async () => {
        await this.setStateAsync(stateId, { val: false, ack: true });
    }, 100);
}
```

### Resource Cleanup Patterns

Always implement proper cleanup in the `onUnload()` method:

```javascript
onUnload(callback) {
    try {
        // Close HTTP servers
        if (this.httpServers) {
            this.httpServers.forEach((server, name) => {
                server.close();
                this.log.debug(`Closed HTTP server for ${name}`);
            });
        }
        
        // Close UDP sockets
        if (this.ssdpSocket) {
            this.ssdpSocket.close();
            this.log.debug('Closed SSDP socket');
        }
        
        // Clear timers
        if (this.connectionTimer) {
            clearTimeout(this.connectionTimer);
            this.connectionTimer = undefined;
        }
        
        // Close connections, clean up resources
        callback();
    } catch (e) {
        callback();
    }
}
```

## Code Style and Standards

- Follow JavaScript/TypeScript best practices
- Use async/await for asynchronous operations
- Implement proper resource cleanup in `unload()` method
- Use semantic versioning for adapter releases
- Include proper JSDoc comments for public methods

## CI/CD and Testing Integration

### GitHub Actions for API Testing
For adapters with external API dependencies, implement separate CI/CD jobs:

```yaml
# Tests API connectivity with demo credentials (runs separately)
demo-api-tests:
  if: contains(github.event.head_commit.message, '[skip ci]') == false
  
  runs-on: ubuntu-22.04
  
  steps:
    - name: Checkout code
      uses: actions/checkout@v4
      
    - name: Use Node.js 20.x
      uses: actions/setup-node@v4
      with:
        node-version: 20.x
        cache: 'npm'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Run demo API tests
      run: npm run test:integration-demo
```

### CI/CD Best Practices
- Run credential tests separately from main test suite
- Use ubuntu-22.04 for consistency
- Don't make credential tests required for deployment
- Provide clear failure messages for API connectivity issues
- Use appropriate timeouts for external API calls (120+ seconds)

### Package.json Script Integration
Add dedicated script for credential testing:
```json
{
  "scripts": {
    "test:integration-demo": "mocha test/integration-demo --exit"
  }
}
```

### Network Testing Best Practices (Fakeroku-Specific)

For adapters that create network services like fakeroku:

#### Mock Network Environment Testing
```javascript
const { tests } = require('@iobroker/testing');
const http = require('http');
const dgram = require('dgram');

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Network Service Testing', (getHarness) => {
            let harness;
            let mockHarmonyHub;
            
            before(async () => {
                harness = getHarness();
                
                // Create mock Harmony Hub that sends SSDP requests
                mockHarmonyHub = dgram.createSocket('udp4');
            });
            
            after(async () => {
                if (mockHarmonyHub) {
                    mockHarmonyHub.close();
                }
            });

            it('should respond to Harmony Hub discovery', async function() {
                this.timeout(30000);
                
                // Configure adapter with test device
                await harness.changeAdapterConfig('fakeroku', {
                    native: {
                        BIND: '127.0.0.1',
                        devices: [{
                            name: 'TestRoku',
                            port: 9093,
                            uuid: 'test-12345'
                        }]
                    }
                });
                
                await harness.startAdapter();
                await new Promise(resolve => setTimeout(resolve, 5000));
                
                // Simulate Harmony Hub discovery request
                const discoveryMessage = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nST: roku:ecp\r\n\r\n';
                
                return new Promise((resolve, reject) => {
                    mockHarmonyHub.on('message', (message, remote) => {
                        const response = message.toString();
                        if (response.includes('roku:ecp') && response.includes('TestRoku')) {
                            resolve();
                        }
                    });
                    
                    mockHarmonyHub.send(discoveryMessage, 1900, '239.255.255.250');
                    
                    setTimeout(() => reject(new Error('No SSDP response received')), 10000);
                });
            });
        });
    }
});
```

#### HTTP Command Testing
```javascript
it('should handle ECP commands via HTTP', async function() {
    this.timeout(20000);
    
    await harness.startAdapter();
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Send keypress command to adapter
    const response = await new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: 9093,
            path: '/keypress/Home',
            method: 'POST'
        }, (res) => {
            resolve(res);
        });
        
        req.on('error', reject);
        req.end();
    });
    
    expect(response.statusCode).toBe(200);
    
    // Verify state was created
    await new Promise(resolve => setTimeout(resolve, 1000));
    const homeKeyState = await new Promise((resolve, reject) => {
        harness.states.getState('fakeroku.0.TestRoku.Home', (err, state) => {
            if (err) return reject(err);
            resolve(state);
        });
    });
    
    expect(homeKeyState).toBeTruthy();
    expect(homeKeyState.val).toBe(true);
});
```