# RhemaCast: Random Feature Notes

These are some random features and thoughts I have for this app. I'll add more notes as time goes on and I think of them.

> [!NOTE]
> **All features below have been formally integrated into the documentation suite.** See:
> - Features 1, 2, 3, 5 → [display_and_broadcast.md](display_and_broadcast.md)
> - Feature 4 → [search_engine.md](search_engine.md)
> - Feature 6 → [architecture.md](architecture.md), [threading_and_lifecycle.md](threading_and_lifecycle.md)
> - Feature 7 → [architecture.md](architecture.md), [gpu_and_hardware.md](gpu_and_hardware.md), and cross-platform notes across all docs

---

### 1. Version Interaction
Double click on a bible version/translation in the manual section to switch to displaying the selected verse directly. Click once to switch to just browsing through that bible version.

### 2. Hotkeys & Configuration
Should include the ability to configure hotkeys. Perhaps intercept function key events? These are usually not used.
- Map double mouse click to a key.
- Add ability to clear with a key. Clicking the key when already clear will display the last cleared verse.
- Add ability to switch themes with a key. This will be one key—press multiple times to switch down your list of themes. Press another to switch back to the very first theme so the operator can easily memorize the fact that "lower third theme is five button presses after reset button."

### 3. Schedule Workflow
Drag a verse to the schedule area to add it to the schedule, just like EasyWorship.

### 4. The "Magic" Navigation (EasyWorship Style)
How do I describe this? There's something EasyWorship does that this app absolutely must copy. It has to do with how scripture navigation is handled.

It seems the navigation box is divided into three sections (not obviously so, but that's how it behaves):
1. The book (Genesis, Exodus, etc.)
2. The chapter
3. The verse

When you select a book, only the characters that make up the name of that book get highlighted. You don't even have to double click. Click once over the book to highlight the book. Same for chapter and verse.

**The Magic Part:**
From the moment you begin typing, it anticipates what you're looking for, and very strictly so. Let me explain:

If I type 'e', Exodus appears, all characters highlighted except the 'e' that I typed. If I type 'x', the 'Ex' in 'Exodus' are now the only characters that are NOT highlighted. It continues in that vein until I finish typing the entire 'Exodus'.

As for the "strictly" I was talking about... Say I've typed 'Ex'. If I now type 'b' instead of 'o', that 'b' entry is ignored and I'm still left with 'Ex' as the only visible and unhighlighted characters. Basically, if what I'm typing doesn't strictly correspond to a character of a book of the bible in the proper order/position, it gets ignored.

If I were to start by typing 'v', as there's no book of the bible that starts with 'v', nothing happens. The entire book still remains highlighted. Only valid characters get unhighlighted.

If I type '1', the entire book text automatically changes to... what's the first book of the bible that has a first and second part? 1 Samuel? The entire text changes to that. After typing '1', I don't need to press space bar before I continue typing 'sam' or 'chr' or 'jo', or whatever. The space bar is strictly for moving the focus (the highlight) to the next section (from book to chapter, or from chapter to verse).

It doesn't come up with a list of results as you try to navigate. It simply produces the first, closest book to what you're typing, with that strictness I mentioned earlier.

This feature absolutely must be integrated in RhemaCast. I have gotten used to it and know how useful it is. It makes navigating through scriptures incredibly fast and efficient.

### 5. Theme Designer
Theme designer is a tab in the `index.html` file I'm using as a draft to visualize the frontend of this app. In actuality, it will probably be under plugins, or a separate app, or an external website that runs in a browser. Most likely under plugins.

My vision for the theme designer is a result of the architectural decision to use a websocket connection to offload theme rendering to the system running the broadcast software. As we are sending code to the other system—mere text, html, and javascript—we might as well take full advantage of the rendering power of that system.

Also, users can't all be expected to know HTML and CSS, so the theme designer will provide a user-friendly drag-and-drop interface to create and customize themes. Think Elementor.

### 6. Browser-like Performance
If possible, I would like this app to behave more like a browser than just having tabs like a browser. For snappy startup and better performance, how about the system loads just the presentation tab on startup, just like a browser does? When the user clicks on a tab, THEN it loads.

### 7. Cross-Platform Development
This is perhaps the most important part. **I AM DEVELOPING ON A LINUX SYSTEM, BUT THIS APP IS TO RUN ON WINDOWS.** I have to test this app locally, on Linux, but compile to Windows .exe (would be nice if this can be compiled to .deb too). This will be a bit complex because we're making heavy use of GPU. What a great time to be alive!

---

### 8. No Auto-Display (Decision)
I have decided not to do any auto-display thing. Instead, the verses with the closest link to what is being said are placed at the top of the review queue. No auto render. I MIGHT reconsider this decision later, perhaps making it configurable, but for now, it's a no.

---

*I will add more notes as time goes on and I think of them.*