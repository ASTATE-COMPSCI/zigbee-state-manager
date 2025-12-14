const express = require('express');
const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const db = new Database('./plugs.db');
const mqttClient = mqtt.connect(process.env.MQTT_CONNECTION_STRING);

db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT)');
db.exec("INSERT OR IGNORE INTO state (id, value) VALUES (1, 'OFF')");

const getState = db.prepare('SELECT value FROM state WHERE id = 1');
const setState = db.prepare('UPDATE state SET value = ? WHERE id = 1');

// Track recently commanded devices to avoid feedback loops
const recentlyCommanded = new Set();
const commandTimeout = 2000; // 2 seconds

// Track pending sync operations to debounce
const pendingSyncs = new Map();
const syncDebounce = 500; // 500ms

function markDeviceCommanded(device) {
    recentlyCommanded.add(device);
    setTimeout(() => recentlyCommanded.delete(device), commandTimeout);
}

function scheduleSyncDevice(device, desiredState) {
    // Clear existing timeout if any
    if (pendingSyncs.has(device)) {
        clearTimeout(pendingSyncs.get(device));
    }
    
    // Schedule sync after debounce period
    const timeout = setTimeout(() => {
        mqttClient.publish(`zigbee2mqtt/${device}/set`, JSON.stringify({ state: desiredState }));
        markDeviceCommanded(device);
        pendingSyncs.delete(device);
    }, syncDebounce);
    
    pendingSyncs.set(device, timeout);
}

mqttClient.on('connect', () => mqttClient.subscribe('zigbee2mqtt/+'));

mqttClient.on('message', (topic, msg) => 
{
    const device = topic.split('/')[1];
    
    // Ignore group messages and non-device topics
    if (device === process.env.ZIGBEE_GROUP || !device) return;
    
    const data = JSON.parse(msg);
    const { value } = getState.get();
    
    // Handle state updates
    if (data.state) 
    {
        // Ignore if we just commanded this device
        if (recentlyCommanded.has(device)) {
            return;
        }
        
        // Only sync if state doesn't match desired state
        if (data.state !== value) 
        {
            scheduleSyncDevice(device, value);
        }
    } 
    // Handle device coming online
    else if (data.availability === 'online') 
    {
        scheduleSyncDevice(device, value);
    }
});

app.get('/state', (req, res) => 
{
    const { value } = getState.get();
    res.json({ state: value });
});

app.post('/state', (req, res) => 
{
    const { state } = req.body;
    
    if (state !== 'ON' && state !== 'OFF') {
        return res.status(400).json({ error: 'State must be ON or OFF' });
    }
  
    setState.run(state);
    
    // Use group command for all devices at once
    mqttClient.publish(`zigbee2mqtt/${process.env.ZIGBEE_GROUP}/set`, JSON.stringify({ state }));
    
    // Clear any pending individual syncs since we're commanding the group
    pendingSyncs.forEach((timeout) => clearTimeout(timeout));
    pendingSyncs.clear();
    
    res.json({ success: true, state });
});

app.listen(5000, () => {});