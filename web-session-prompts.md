# Prompts from the Claude Code for web sessions

My prompts from each Claude Code for web session linked from this repo's commit messages, oldest first. Each heading is the date and first line of the commit on `main` that landed that session's work.

## 2026-09-28: Initial game

[session_015RYeKm4ji4N16oqthyX1b1](https://claude.ai/code/session_015RYeKm4ji4N16oqthyX1b1) · commit `24a7925`

- We are going to build a mobile friendly RTS game - command and conquer style - called Battle Dromes, in which two armies of drones (both flying and ground-based) battle for territory and resources

  Let's start with a MVP design, ask me some questions
- Full screen, touch controls (mouse as well I guess) that are specifically designed to work well on a mobile phone in portrait or landscape mode
- It's called "Battle Drones" - the M was a typo
- OK build it all, use TDD where appropriate, commit and push frequently including the placeholder sprites as early as possible so I can work on better designs for them in parallel
- Did you get my message about building everything to html and js and committing that so GitHub pages can serve it without an extra build step?
- It will be hosted at https://simonw.github.io/battledrones/
- Every time you push this branch ~30 seconds later GitHub pages will have deployed it there so you can test it too if you like
- Should I see anything on that URL right now? I just get a white page
- Git pull to see what's going on in other branches - there's a branch with some initial graphic assets in, that branch will never be merged but you can copy assets you need over from it
- Should that be pushed and deployed yet?
- When I load it in a browser I can see the initial game state - a base, a vehicle, fog of war, fan and AirPad and turret and Harv buttons -  it nothing happens, I can't click or drag anything, I can't click the buttons
- Commit and push as soon as you think it might work - even if you haven't finished manually testing yourself

  That other branch has more unit sprites for you now
- Explain the units to me
- Add a toggle button for turning fog and war on and off (for debugging)
- Add a mode where you can instead of clicking play at the start click "Play AI vs AI" - then both sides are AI and fog of war is off and you can just watch what happens, make sure the AIa have several strategies that they randomly pick between at the start
- Pull the other branch, there are more assets for you, don't even bother looking at them just copy them into place and deploy them

  I think there's a bug where units can stack on top of each other, I keep having games where one enemy tank rolls in and then splits into a bunch
- Brainstorm ways we could make this more fun
- On mobile I managed to zoom in such that the buttons were bigger and now I can't zoom out or access the mini map at all

  Generally I find panning and zooming the map hard on both mobile an desktop - on desktop the cursor arrow keys should move the map view around, come up with more intuitive and reliable mobile controls too, plus smooth zoom in and out buttons on desktop
- Can we create higher resolution sprites for the vehicles from the assets we saved in that other branch?
- On mobile holding down two fingers and moving is meant to pan the map right? That semi works but is a bit weird

  It's still possible to accidentally zoom in on mobile safari and not be able to zoom out again, can we detect that condition and add a visible "zoom back out" tappable button across the bottom of the screen when it happens?

  Add an AI strategy that emphasizes flying vehicles, it only builds them, no ground vehicles at all (but does use turrets)
- On mobile the new zoom in and zoom out on screen buttons don't seem to zoom on the center of the current visible area, they are zooming on some other central coordinate that I don't understand
- skyforce always wins - we should make the Ai smarter generally, a few ideas:
  1. AI should notice if there are enemy units that are not being attacked and move relevant attacking units to that location
  2. AI should adapt to what enemy units are showing up and build unit types that counter them

  Suggest more strategies for me to approve before building
- What are the rules about how many of different unit types are allowed at once?

## 2026-10-06: Overhaul Battle Drones: painted art, 11 units, 8 buildings, 5 maps

[session_01Jk2CVAMe6RtfuX93r898Mb](https://claude.ai/code/session_01Jk2CVAMe6RtfuX93r898Mb) · commit `89fbd16`

- Massively improve this game. Make the graphics and gameplay better (keep it mobile friendly). Render new graphics using the latest OpenAI GPT image API (lookup details) with the API key in the environment variable. Add new unit types and balance the gameplay better. Also add new buildings and better, more varied terrain.
- Commit and push early and often so I can preview your work
- Commit and push each asset as soon as it is generated

## 2026-10-07: Make it a lot more fun

[session_01D5AwyWXSsAwcsrABsEtWKX](https://claude.ai/code/session_01D5AwyWXSsAwcsrABsEtWKX) · commit `2afb7cb`

- This game isn't fun enough yet. Make it a LOT more fun.
- I can't merge it
- Merge it into main
- Write detailed release notes for the new gameplay features that we just landed

## 2026-10-08: Port to three.js: 3D models for every unit, building and landscape

[session_01Ls8oTMXGgC3XyffTNCNVhB](https://claude.ai/code/session_01Ls8oTMXGgC3XyffTNCNVhB) · commit `e8db579`

- Port this game to three.js with 3D models for all of the buildings and vehicles and landscapes
- Create a PR with detailed changelog in the PR body

## 2026-10-09: Visual polish: textured rocks, terrain, lighting, models, effects, overlays and HUD

[session_016LaJRpTfBoD6aMG2TPYmMc](https://claude.ai/code/session_016LaJRpTfBoD6aMG2TPYmMc) · commit `6d4261f`

- Apply visual polish
- Status? Any images I can look at?
- The rocks don't look much better
- Can we texture the 3D rocks using the existing imagery?
- Status report? Screenshots?
- show me screenshots of the changes you made to the models
- You done yet?
- Open a PR with detailed changelog notes in the PR description

## 2026-10-09: Shift+click adds or removes a unit from the selection (#6)

[session_01NUvgRjwF2VvGa5E2WpKgpq](https://claude.ai/code/session_01NUvgRjwF2VvGa5E2WpKgpq) · commit `883aab6`

- Add keyboard shortcuts for players with a keyboard. First discuss them with me - I want Esc to cancel a selection, shift+click to add or remove a unit from the existing selection, tap 1 / 2 / 3 to select those squads, hold 1 / 2 / 3 to redefine the current selection as the squad. What else do you suggest?
- OK so maybe all we need to add is the shift click to toggle on/off a unit in the current selection
- are the keyboard shortcuts documented in the UI anywhere?
- commit and push the shift click work

## 2026-10-10: Robot infantry and Condor dropship

[session_013guxRc31LG6TxaYGp62Jw7](https://claude.ai/code/session_013guxRc31LG6TxaYGp62Jw7) · commit `0e9d6c6`

- Read and then implement INFANTRY.md - make sure the new models look great
- I think all players always start the game with one squad of troopers
- status?
- show me any existing images of the condor and the infantry
- go
- Any reason not to commit and push do I can try it while you are still testing ?
- what's left to do?
- do it, drop cannon vs infantry from 0.6 to 0.4
- when done open a PR with a detailed changelog in the PR body

## 2026-10-10: Infantry War and Airborne mutators

[session_01SN5tSwYqaHBuzPfrhnYHDY](https://claude.ai/code/session_01SN5tSwYqaHBuzPfrhnYHDY) · commit `1fbd0c4`

- Suggest new infantry based mutators - I want an infantry only one and one where you start with a drop ship and one of each type of infantry squad
- Push a playable version to a branch while you are still testing
- Push that preview even before runs have finished
- Open a PR with detailed change notes

## 2026-10-10: "New version ready" pill with an Update button on the Home Screen

[session_01YH7ARFKVhkDrW5dzQETQMu](https://claude.ai/code/session_01YH7ARFKVhkDrW5dzQETQMu) · commit `62e2d26`

- Often the cache means I don't see new updates to the code - add a feature where if there is an update the Home Screen tells you about it and provides a button to upgrade
- Why does it say "reload to play the latest build"? Won't clicking update to that without a browser reload
- open a PR

## 2026-10-10: AI fixes: Menders, shooting Menders, wreck pickups, Condor use

[session_011cgdzbkGLcAMrLc65w668W](https://claude.ai/code/session_011cgdzbkGLcAMrLc65w668W) · commit `c8e1db1`

- Some AI bugs I've spotted:

  - menders often fly to the enemy base and then hang around there for seemingly no reason
  - units should attack menders more aggressively
  - units (including harvesters) often ignore nearby destroyed vehicles even though that's a very quick way to pick up some extra scrap
  - AI players with a Condor (including in the mutator that gives them a free one) don't seem to use it for anything
- Open a detailed PR

## 2026-10-10: Archipelago

[session_01XNmSs5RjyPXK8k2FAd9Sh7](https://claude.ai/code/session_01XNmSs5RjyPXK8k2FAd9Sh7) · commit `1f4f25d`

- Design a new map. Goal is to make different strategic incentives that encourage use of Infantry and Condors and aerial vehicles.

  To do this the map will have limited harvester resources but several more uplinks - but uplinks will be on islands that are inaccessible by land vehicles or infantry. These uplinks can also not be claimed using air vehicles. The ONLY way to get them is to fly infantry there in a Condor.

  Armies always start with a Condor and a single squad. If an army has no Condor a new one will be provided for free, flying in from the edge closest to their HQ and landing there. That free condor will come with a single free squad on board.

  The two HQs should be entirely separated by water, but still accessible by vehicles thanks to two bridges across the map in different places

  I want to encourage a battle over uplinks.

  The map should be the times the size of other maps - still square

  First research and then critique this design. Only build after we have agreed on any modifications 

  You get to design a new biome for this
- On mobile it's not obvious that the map selection part can be scrolled sideways to reveal another option (Proving Grounds) - since we are adding another map we should fix that, also proving grounds should come first and the new map should come last
- I have to go out for the day, so I've changed my mind: no need to wait on me for any decisions, use your own judgement to get this built. Commit early and often and push your commits to a branch so I can see them.
- Push
- How come the last deploy to GitHub pages for this branch was 24m ago? Build in docs and push
- Do a build docs and push now, then another final one once AI is finished
- Open a PR with detailed notes

## 2026-10-10: Edge arrows point south at fights behind the camera (#14)

[session_015K3cAboDnjF16Zvc6hhMqr](https://claude.ai/code/session_015K3cAboDnjF16Zvc6hhMqr) · commit `3f4ef22`

- I was watching an AI vs AI game on the new archipelago map and the "fight" arrows sometimes pointed in the wrong direction.
- Rebase from main
- PR

## 2026-10-10: Archipelago: room between the gulf islands, and a more natural layout

[session_013SWRuajxmnmHBGV5HLacwa](https://claude.ai/code/session_013SWRuajxmnmHBGV5HLacwa) · commit `3ca11d8`

- The new archipelago map - I don't like how close together the three islands in the north and the three islands in the south are. It feels fake. Redesign the map to give them a little bit more space and make them feel a bit more natural. Increase the map's size if you need to.
- PR with detailed notes

## 2026-10-11: Version the map terrain URLs: no stale paint from the service worker

[session_01UnUuu28QUHLe2wNV1DXfu8](https://claude.ai/code/session_01UnUuu28QUHLe2wNV1DXfu8) · commit `72a281a`

- Look at most recent commits. Look at these screenshots. Something clearly went wrong, there are weird artifacts on the edges near the bases and the map tiles on the new uplink islands do not match the expected design from the mini map

  The uplinks should not be on the ocean. They should be on land (islands)

## 2026-10-11: iOS Home Screen icon: a 180px opaque touch icon (#17)

[session_01PuTTjWYpEm26HixEjEqNvB](https://claude.ai/code/session_01PuTTjWYpEm26HixEjEqNvB) · commit `cddf6e2`

- I want that to have a nice icon

## 2026-10-11: Design proposals: 1v1 online multiplayer, and agent-vs-agent battles

[session_01E9NvCJdvgJiAJXTdmvb6b7](https://claude.ai/code/session_01E9NvCJdvgJiAJXTdmvb6b7) · commit `2bd708d`

- Propose a design for 1v1 multiplayer mode using a websocket based cloudflare worker in MULTIPLAYER.md - optional, no indication of it at all if the worker URL is not configured.  Based on sharing URLs so one player creates a session and sends the URL for their opponent. The document should present options where appropriate.
- How complex or expensive would it be to permanently log each battle such that it could be replayed using the original shared link? And site admins could watch the battles / coding agents could use the logs for further gameplay tweaks?
- Fun extra challenge: think about how we might make multiplayer available to coding agents. It would be neat if we could set up a battle between eg GPT-6 Sol and Claude Opus 5.5 where each model has access to a tool which gives them information about the game (presumably non-visual, but only the information they could see through fog of war etc) and lets them control their units etc
- Explain the "you always play blue" decision?
- Why is it hard to have the host player blue in lower left corner and the other player red in top right, with both seeing the same colors and orientation?
- Yes update with my recommendation
- Split the agent v agent mode into a separate document, since that doesn't need realtime WebSockets and can actually be run on the same
  Machine so doesn't even need the network. Make the agent v agent spec standalone.
- Consult ~/dev/llm/docs and include notes in that file about how LLM could be used here via a new tools plugin
- Update the PR title and description to mention the agent v agent thing too

## 2026-10-11: Agent battles: AI models play each other, with an LLM plugin and replays

[session_01TNeyEGjxrx2wLa61E4HCeS](https://claude.ai/code/session_01TNeyEGjxrx2wLa61E4HCeS) · commit `4423029`

- Read and then implement AGENT-BATTLES.md including the LLM plugin. Test it using two GPT-6 Luna (you have an API key for that) playing against each other.
- Also make sure there's a way to watch the battle as the agents play it
- And that battles are recorded and there's a way to replay a recorded battle by pasting JSON in a box somewhere (in the live game too)
- Actually, do not implement the live viewing yet, just the replays after the battle
- What commands do you run to simulate a battle with LLM? Just answer here
- Next run a battle between GPT-6 Luna and GPT-6 Astra both on reasoning effort low -
- What commands do you run to simulate a battle with LLM? Just answer here
- commit the battle records and open a PR
- Wait did you remove the watch AI vs AI button?
- [image]

  I don't see the watch AI button any more
- [image]

  OK explain this
- Can you make that in a new branch from main and open a new PR? And can you upgrade the existing saved battles so they will work with the new code?
- Did you get my last message?

## 2026-10-11: Battle records by link: ?replay= in the game and a record viewer

[session_01UHFnYt21g1L17tQNaxjCCj](https://claude.ai/code/session_01UHFnYt21g1L17tQNaxjCCj) · commit `ed86441`

- Fetch https://claude.ai/artifact/JgiEQxwupoMnbiKWcKJ5RD source code
- Add that to the repo but give it a feature where you can also give it a URL to a CORS-enabled JSON file and it will fetch and render that - and that goes in the ?url= parameter so you can bookmark it

  Links to Gists should work too - take a look at a /tmp checkout of simonw/tools for examples of apps that do that, the SVG markdown one is good for that

  Also edit the README so it has a section near the top that links to the three example battles we have in that viewer

  AND upgrade the main game so it can take a ?url= parameter which triggers a replay of that file too, and link to those as well

  Import latest code from main first
- When you commit the new viewer include a link to https://claude.ai/share/8f6bb0cd-53e9-47ff-b1f0-c6f3b4b4f488 in the commit message
- Actually do ?replay= for both
- Open a PR with a detailed message
- Use your OpenAI key and llm to run a battle on archipelago between GPT-5.6 Sol and GPT-6.1 Sol - add the battle to the repo and link from README
- Any highlights from the transcript so far?
- Cost estimate so far? Prices are https://www.llm-prices.com/current-v1.json
- Keep telling my highlights every now and then
- You push that to main?
- Add https://github.com/simonw/agent-note (a private repo) and check that out to /tmp
- export AGENT_NOTES_API_URL='https://agent-notes-cloudflare.simonw.workers.dev/api/notes'
  export AGENT_NOTES_API_SECRET='[redacted]'

  Then use it to add that DB file as an attachment
- GO ahead with the gzipped upload
- in main
- push it to main

## 2026-10-12: GOLIATH.md: a spec for the Goliath mobile-base mech

[session_01UWiMtsL9QraCEMjWEgdYzt](https://claude.ai/code/session_01UWiMtsL9QraCEMjWEgdYzt) · commit `b70ab73`

- Help me brainstorm ideas for adding giant robots to this game - think dreadnoughts or titans from W20K - how could we do this in a. Way that enhanced gameplay, kept things balanced, added unique twist? Don't overthink this yet
- Let's keep brainstorming. I like the idea that it's a mobile base - that can accept harvested scrap and can have buildings built near it (even if it later moves on) and can produce infantry units too. An interaction with condor would be neat but I don't know what that could be.
- Idea: as it gets damage it loses the ability to fire some weapons - by default it has eye laser (like lancers) and arm canons (like titan) and two shoulder mounted mortars, plus machine guns similar to a squad of troops

  Damage knocks out mortars and then laser - it always has guns
- You can't build next to a building that was only put there because of the mech, you need the mech there for off-base building and only within three squares of it 

  Yes to just be anchored for harvesting and building - with a cool animation
- Repaired brings weapons back, needs menders for that
- Ok share the spec so far, not as a document just as text here
- 1. Only when anchored
  2. Arm canons get knocked out last, but always has machine guns
  3. Any building
  4. It can anchor anywhere that a building could be placed
  5. Menders only - and the fact that it might need 2 or 3 to make much of a difference is a feature, I like the idea of it having several menders working on it
  6. Yes you are not defeated until all of your mechs are destroyed (and you can have multiple mechs, but they get a bit more expensive for each subsequent one built)
  7. Lets do two condors can carry the mech

  For naming: we should rename the titan tank to something else to avoid confusion

  For the big mech itself, I like Goliath
- Need more options for Titan rename 

  We are going to have to start tying replays to tagged versions of the game - then we don't have to worry about renames etc 

  I want it built by a new building called a Gantry which can only be built if you have the airpad and tech and fab and the infantry building too

  I like the idea that it can see further but is also always visible to enemy

  No need to have it crush on toppling but yes to lost of scrap spread over a wider area 

  No building a new HQ

  No special rules for uplinks on islands
- Mastodon for the tank. Ignore the backwards compatible replay problem for the moment - we will solve it later 

  Let's have the gantry building use different visual states to reflect the progress in building the Goliath

  Cost increase of 25% is fine

  Yes can still build after HQ falls

  Yea to warnings on building
- Let's say gentry can be sen through fog, it's a big building! Only one gantry  can be built per side

  The specification should make it clear. that all numbers are flexible and should be tuned during automated play testing for balance
- Yes to the proposals. Note that we won't worry about LLM command just yet. Save the spec as GOLIATH.md

## 2026-10-12: The Goliath: a walking mobile base, its Gantry, Nomads and Robot Love

[session_01MYEP2tbCGeRAnxTUNbD3wL](https://claude.ai/code/session_01MYEP2tbCGeRAnxTUNbD3wL) · commit `0248adc`

- Read the GOLIATH.md spec and built it
- Commit and push the rename as soon as it's done
- Generally you should commit early and often in this project
- Add a mutator for starting the game with one Goliath each
- Actually that mutator is you start with a Goliath instead of a base!
- Add a mutator called "Robot love" - in that mutator if two enemy Goliaths get within 5 squares of each other they fall in love and there's a canned animation of them meeting and then hearts bubble out of them and the game ends in a draw
- Include screenshots of the rendered new Goliath and Gantry models in one of the commits that you then post, in a new folder for in progress shots that we can use for other Wikipedia stuff in the future
- Don't worry both replays I have a separate fix for those
- How close is the AI work to done?
- Tell AI agent to wrap up now but leave a markdown note in the repo about why it's not finished and what could be done next
- That AI agent doesn't seem to have wrapped up yet
- How will the Goliath work on mobile web? What new tap commands etc are there?

  Can it produce new infantry? How does it know if the infantry should come out of the Goliath as opposed to a bay?
- Bias towards finishing I can't play test until it lands on main
- You can leave notes for what to fix later in a markdown file
- Hurry up and finish I want to play!!
- Open a PR with detailed notes

## 2026-10-13: New Raptor, Lancer and Hornet models

[session_01J9EWouA1eTLvkC1rk5FTC2](https://claude.ai/code/session_01J9EWouA1eTLvkC1rk5FTC2) · commit `12a4d0a`

- The laser tank and the aircraft that fires at other aircraft have models that look too similar

  Show me alternative designs for that aircraft, as 3-D models that you render and take screenshots of
- The hover tank should look more like a hover tank, too
- And let's make the bomber aircraft look a bit more different from scouts and condors too
- For Raptor, I want Twin Boom. For Lancer: skirted grav-tank. For Hornet: the airship
- Open a PR, include relevant screenshots in the PR description

## 2026-10-13: HUD portraits shot from the 3D models, blue and red

[session_01EThGFwWbZUWRpgeWh2ybhk](https://claude.ai/code/session_01EThGFwWbZUWRpgeWh2ybhk) · commit `33f924f`

- Consider the recently landed change that redesigned some models

  Consider the icons used for models and buildings and units

  Propose ways of making those icons more clear and a better fit for our current visual language
- Those are great, open a PR with images in the description showing before and after
- So will merging this PR cause the new images to show up in the game?
- Same PR do it
- [image]

  Can we rotate that so the dish is facing forwards
- Be sure to update vehicles.html too
- rotate the uplink dish to the front too, and re-crop the radar one so a bit less of the dish is missing

## 2026-10-13: Goliath Armada mutator: four airborne Goliaths each, nothing else (#26)

[session_016J31mhjNDrWaKEeC6yWysg](https://claude.ai/code/session_016J31mhjNDrWaKEeC6yWysg) · commit `360595c`

- Suggest a name for a mutator that gives each side four Goliaths each starting with two condors attached to each so all four are flying at the start
- "Goliath Armada" with your choice of icon, implement that, don't bother to play test it or balance test it
- they should not have any other units, or buildings not even an HQ
- "The AI sets its Goliaths down and starts building" - I hope the AI at least spreads them out a bit
- PR
