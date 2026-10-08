# Improvements

Ideas that came up while using the plugin. Not scheduled.

## "Any matched topic is active" (several events, one motion sensor)
The Dummy Switch plugin's *Custom Motion Sensor* extension **replaces** the camera's own motion sensor
with the selected one (`ReplaceMotionSensor` in Scrypted's `plugins/dummy-switch`). To record on normal
motion **and** on, say, animals (events of `axis-animal-detector`), both signals have to end up in one
mapper device.

A regex topic such as `/(MotionRegionDetector\/Motion|AnimalDetector\/Any)$/` with an empty item name
catches both, but the device has a single motion flag: if one event says "off" while the other is
still "on", the last event wins and motion ends too early.

Idea: remember the state per matched topic (a set of the topics that are currently active) and report
motion as long as at least one of them is active. A "false" removes only its own topic from the set.
Keep the current behaviour (one flag) as the default, e.g. behind a setting "Combine matched topics
(any active)", so that existing devices do not change. The "Motion Reset" timeout should then clear
the whole set.

Open: what to do with item names that differ per topic (`State` for the camera's motion, `active` for
the animal events): an empty item name matches on the topic alone, which is fine for single-item
events.

## Events with several data items
Events with more than one `simpleItem` (for example a species and a score) are ignored. Idea: let the
device pick one item by name from such an event.
