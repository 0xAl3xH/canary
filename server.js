const MerossCloud = require("meross-cloud");
require("dotenv").config();
const twilio = require("twilio");
const VoiceResponse = twilio.twiml.VoiceResponse;
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const express = require("express");
const urlencoded = require("body-parser").urlencoded;

const app = express();
let dev = undefined;
const GARAGE_OPEN_THRESHOLD = Number(process.env.GARAGE_OPEN_THRESHOLD);

// Parse incoming POST params with Express middleware
app.use(urlencoded({ extended: false }));

const callees = process.env.CALLEES.split(",");
let reminderId = undefined;
let nagId = undefined;

function cleanup() {
  if (reminderId !== undefined) {
    console.log("removing reminder");
    clearTimeout(reminderId);
    reminderId = undefined;
  }

  if (nagId !== undefined) {
    console.log("removing nag");
    clearInterval(nagId);
    nagId = undefined;
  }
}

// Create a route that will handle Twilio webhook requests, sent as an
// HTTP POST to /voice in our application
app.post("/voice", (req, res) => {
  const twilioSignature = req.headers["x-twilio-signature"];
  const url = process.env.SERVER_URL + "/voice";
  const params = req.body;

  const isAuthenticTwRequest = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    url,
    params
  );
  console.log(isAuthenticTwRequest);

  // Use the Twilio Node.js SDK to build an XML response
  const twiml = new VoiceResponse();

  // Use the <Gather> verb to collect user input
  function gather() {
    const gather = twiml.gather({ numDigits: 1 });
    gather.say(
      "You left your garage door open. To close, press 1. To snooze, press 2. To ignore, press 3"
    );

    // If the user doesn't enter input, loop
    twiml.redirect("/voice");
  }

  // If the user entered digits and it actually came from twilio, process their request
  if (req.body.Digits && isAuthenticTwRequest) {
    switch (req.body.Digits) {
      case "1":
        twiml.say("The garage will be closed, goodbye");
        console.log("Closing garage door");
        dev.controlGarageDoor(1, false, (err, res) => {
          console.log("open " + JSON.stringify(res, null, 2));
        });
        break;
      case "2":
        twiml.say("This notification has been snoozed, goodbye");
        break;
      case "3":
        twiml.say("Notification canceled, goodbye");
        cleanup();
        break;
      default:
        twiml.say("Sorry, that was not a valid choice");
        twiml.pause();
        gather();
        break;
    }
  } else {
    // If no input was sent, use the <Gather> verb to collect user input
    gather();
  }

  // Render the response as XML in reply to the webhook request
  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/call", (req, res) => {
  console.log("Creating call");
  client.calls
    .create({
      url: process.env.SERVER_URL + "/voice",
      to: callees[0],
      from: process.env.TWILIO_PHONE_NUMBER,
    })
    .then((call) => console.log(call.sid));
});

function notify() {
  client.calls
    .create({
      url: process.env.SERVER_URL + "/voice",
      to: callees[0],
      from: process.env.TWILIO_PHONE_NUMBER,
    })
    .then((call) => console.log(call.sid));
}

function nag() {
  notify();
  nagId = setInterval(notify, 30 * 1000);
}

const options = {
  email: process.env.MEROSS_EMAIL,
  password: process.env.MEROSS_PASSWORD,
  // mfsCode: '123456', // optional
  // tokenData: {...}, // Old Tokens - get after connect via "getTokenData()
  logger: console.log,
  localHttpFirst: true, // Try to contact the devices locally before trying the cloud
  onlyLocalForGet: true, // When trying locally, do not try the cloud for GET requests at all
  timeout: 3000, // Default is 3000
};

const meross = new MerossCloud(options);

meross.on("deviceInitialized", (deviceId, deviceDef, device) => {
  console.log("New device " + deviceId + ": " + JSON.stringify(deviceDef));

  device.on("connected", () => {
    app.listen(1337);
    dev = device;
    console.log("DEV: " + deviceId + " connected");

    device.getSystemAbilities((err, res) => {
      console.log("Abilities: " + JSON.stringify(res));

      device.getSystemAllData((err, res) => {
        console.log("All-Data: " + JSON.stringify(res, null, 2));
      });
    });
    setTimeout(() => {
      console.log("toggle ...");
      device.controlToggleX(1, true, (err, res) => {
        console.log(
          "Toggle Response: err: " + err + ", res: " + JSON.stringify(res)
        );
      });
    }, 2000);
  });

  device.on("close", (error) => {
    console.log("DEV: " + deviceId + " closed: " + error);
  });

  device.on("error", (error) => {
    console.log("DEV: " + deviceId + " error: " + error);
  });

  device.on("reconnect", () => {
    console.log("DEV: " + deviceId + " reconnected");
  });

  device.on("data", (namespace, payload) => {
    console.log(
      "DEV: " +
        deviceId +
        " " +
        namespace +
        " - data: " +
        JSON.stringify(payload)
    );
    if (namespace === "Appliance.GarageDoor.State" && payload.state.length) {
      const data = payload.state[0];
      const time = data.lmTime;
      const open = data.open;
      if (open) {
        reminderId = setTimeout(nag, 1000 * process.env.GARAGE_OPEN_THRESHOLD);
      } else {
        cleanup();
      }
      console.log(payload.state);
      console.log(time, open);
    }
  });
});

meross.on("connected", (deviceId) => {
  console.log(deviceId + " connected");
});

meross.on("close", (deviceId, error) => {
  console.log(deviceId + " closed: " + error);
});

meross.on("error", (deviceId, error) => {
  console.log(deviceId + " error: " + error);
});

meross.on("reconnect", (deviceId) => {
  console.log(deviceId + " reconnected");
});

meross.on("data", (deviceId, payload) => {
  console.log(deviceId + " data: " + JSON.stringify(payload));
});

meross.connect((error) => {
  console.log("connect error: " + error);
});
