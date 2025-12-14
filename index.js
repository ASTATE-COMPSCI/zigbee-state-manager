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

mqttClient.on('connect', () => mqttClient.subscribe('zigbee2mqtt/+'));

mqttClient.on('message', (topic, msg) => 
{
    const device = topic.split('/')[1];
    const data = JSON.parse(msg);
    
    if (data.availability === 'online' || data.state) 
    {
        const { value } = getState.get();
        if (data.state && data.state !== value) 
        {
            mqttClient.publish(`zigbee2mqtt/${device}/set`, JSON.stringify({ state: value }));
        } 
        else if (data.availability === 'online') 
        {
            mqttClient.publish(`zigbee2mqtt/${device}/set`, JSON.stringify({ state: value }));
        }
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
  
    setState.run(state);
  
    mqttClient.publish(`zigbee2mqtt/${process.env.ZIGBEE_GROUP}/set`, JSON.stringify({ state }));
    
    res.json({ success: true, state });
});

app.listen(5000, () => {});