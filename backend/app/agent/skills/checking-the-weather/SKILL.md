---
name: checking-the-weather
description: Gets the current weather for a named city, with condition, temperature in °C and humidity. Covers current conditions only, not forecasts or past weather.
allowed-tools: get_weather
---
# Checking the weather

## Overview

Report the current weather for one city. Done means the user has the condition, temperature and humidity, or a plain reason why not.

## Tools

- Current weather: `get_weather(city)`. Returns one sentence with condition, temperature (°C) and humidity, or an error such as "No matching location found."

## Rules

- If the user names no city, ask which one; don't guess from earlier turns unless they named it there.
- For forecasts or past weather, say only current conditions are available.
- On an error, report it plainly; don't retry with a guessed spelling.

## Examples

**Named city**
User: "What's the weather in Hyderabad?"
Call: `get_weather(city="Hyderabad")` returns "The current weather in Hyderabad is Partly Cloudy with a temperature of 23.9°C and a humidity of 57%."
Answer: "It's partly cloudy in Hyderabad, 23.9°C with 57% humidity."

**Unknown city**
User: "Weather in Xqzzyville?"
Call: `get_weather(city="Xqzzyville")` returns the error "No matching location found."
Answer: "I couldn't find a location called Xqzzyville. Could you check the spelling?"
