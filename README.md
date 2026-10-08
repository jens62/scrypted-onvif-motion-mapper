# scrypted-onvif-motion-mapper

A [Scrypted](https://www.scrypted.app) plugin that maps an ONVIF event of your choice onto a motion
sensor. The built-in ONVIF plugin only recognises a few motion topics; with this plugin any event
a camera sends can switch a `MotionSensor` device on and off.

It was written for an older Axis camera whose motion topic the built-in plugin did not know, and it
works for any ONVIF camera. It is not Axis specific.

## How it works
The plugin opens its own ONVIF PullPoint subscription to the camera, strips the namespaces from every
event topic (`tns1:VideoAnalytics/tnsaxis:MotionDetection` becomes `VideoAnalytics/MotionDetection`),
and looks for a topic that matches your pattern and an item with your item name. A true value starts
motion, a false value stops it. The plugin does **not** attach itself to a camera: it creates a device
that implements `MotionSensor`. Attach it to the real camera with the Dummy Switch plugin's
**Custom Motion Sensor** extension.

Settings of a device:

| Setting | Meaning |
|---|---|
| Host, Port, HTTPS, Username, Password | the camera's ONVIF address |
| Event Topic | a substring of the topic after the namespaces are stripped, or a `/regex/` (with flags) |
| Data Item Name | the name of the boolean item in the event's data (`motion`, `IsMotion`, `State`, `active` ...); empty matches on the topic alone |
| Combine Matched Topics (any active) | for a `/regex/` topic that matches several events: every topic keeps its own on/off state and motion stays on while any of them is on (see below). Off by default |
| Invert Value | for cameras that report a truthy value while there is no motion |
| Motion Reset (seconds) | clears motion after this long if no new "true" arrives; `0` clears only on an explicit "false". With *Combine* it counts for each topic on its own |
| Log All Events | logs every event the device receives (topic, item, value): use it to find the right topic and item name, then turn it off |

Each device has its own PullPoint subscription. Cameras have a limit for these; on a camera that
already answers with HTTP 503, several devices make it worse.

Limits: an event must carry exactly one data item (`simpleItem`). Events with several items, e.g. a
species and a score, are ignored ("onvif event without a simpleItem").

## Example: animals from axis-animal-detector
The [axis-animal-detector](https://github.com/jens62/axis-animal-detector) app reports a stateful event
`tnsaxis:CameraApplicationPlatform/AnimalDetector/Any` (and one per species) with a single item
`active`. To get "an animal is in front of the camera" as motion in Scrypted:

1. Create a device with the camera's host and credentials.
2. Event Topic: `AnimalDetector/Any`, Data Item Name: `active`.
3. Motion Reset: `0`. The detector sends an explicit `active=false` when the animal is gone; the
   default of 30 s would end the motion while the animal is still there.
4. Attach the device to the camera with the Custom Motion Sensor extension.

For single species use `AnimalDetector/Bird` or a regex such as `/AnimalDetector\/(Cat|Dog)$/`.
This is motion only: Scrypted does not get the species or the score.

## Several events on one sensor: normal motion and animals
The Custom Motion Sensor extension **replaces** the camera's own motion sensor with the selected one, so
a mapper device that only knows the animal event leaves the camera's normal motion out. To record on both,
one device has to carry both events:

| Setting | Value |
|---|---|
| Event Topic | `/(MotionRegionDetector\/Motion\|AnimalDetector\/Any)$/` (a regex matching both topics; adapt the first part to what your camera sends, see *Log All Events*) |
| Data Item Name | empty (the camera's motion uses another item name, e.g. `State`, than the animal event, `active`; an empty name matches on the topic alone) |
| Combine Matched Topics (any active) | on |
| Motion Reset (seconds) | `0` if both events send an explicit "false" |

How it behaves with *Combine* on:
- Every matched topic has its own state; motion is on as long as at least one topic is on. A "false"
  of one topic does not end motion while another topic is still on, whichever event came last.
- *Motion Reset* counts for each topic on its own (from that topic's last "true").
- Changing the topic or the combine setting, a reconnect to the camera and removing the device clear all
  topic states, so a missed "false" cannot leave motion on forever.
- With *Combine* off (the default) nothing changes: one shared flag, the last matched event wins.

The topics can be told apart in the log: with *Log All Events* on, a matched event is logged as
`-> matched <topic> ON/OFF, active topics: [...]`.

Not verified on a camera yet; the state logic is covered by a test with timers (`src/combined-motion.ts`).

## Build and install
```sh
npm install
npm run build          # out/plugin.zip
```
`out/` is not in the repository. Deploy with the `scrypted-deploy` script of the Scrypted SDK (see
Scrypted's plugin documentation for the exact call), or install `plugin.zip` by hand.

## Test
`isolated_logic_test.js` checks the order in which the plugin attaches its event listener to the
connection (the listener has to be attached after the camera connected, otherwise the PullPoint
subscription is lost): `node isolated_logic_test.js`.

## Licence
MIT, see `LICENSE`.
