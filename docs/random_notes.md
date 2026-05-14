1. Double click on a bible version/translation in manual section to switch to displaying selected verse directly. CLick once to switch browsing through this bible version.

2. Should include ability to configure hotkeys. Perhaps intercept function key events? These are usually not used.
- Map double mouse click to a key.
- Add ability to clear with a key. Clicking key when already clear will display last cleared verse.
- Add ability to switch themes with a key. THis will be one key. Press multiple times to switch down your list of themes. Press another to switch back to the very first theme so the operator can easily memorize the fact that 'lower third theme is five button presses after reset button'.
- 

3. Drag a verse to schedule area to add to schedule, just like EasyWorship.

4. How do I describe this? There's somethng EasyWorship does that this app absolutely must copy. It has to do with how scripture navigation is handled.

It seems the navigation box is divided into three sections (not obviously so, but that's how it behaves):
1. The book (Genesis, Exodus, etc)
2. The chapter
3. The verse

When you select a book, only the characters of thatr make up the name of that book getr highlighted. You don't even have to double click. Click once over the book to highlight the book. Same for chapter and verse.

Now, this is the part of this that looks to be magic to me. From the moment you begin typing, it anticipates what you're looking for, and very strictly so. Let me explain.

If I type 'e', Exodus appears, all characters highlighted except the 'e' that I typed. If I type 'x', the 'Ex' in 'Exodus' are now the only characters that are NOT highlighted. It continues in that vein until I finish typing the entire 'Exodus'.

As for the 'strictly' I was talking about... Say I've typed 'Ex'. If I now type 'b' instead of 'o', that 'b' entry is ignored and I'm still left with 'Ex' as the only visible and unhighlighted characters. Basically, if what I'm typing doesn't strictly correspond to a character of a book of the bible in the proper order/position, it gets ignored.

If I were to start by typing 'v', as there's no book of the bible that starts with 'v', nothing happens. The entire book still remains highlighted. Only valid characters get unhighlighted.

If I type '1', the entire book text automatically changes to... what's the first book of the bible that has a first and second part? 1 Samuel? The entire text changes to that. After typing '1', I don;t need to press space bar before I continue typing 'sam' or 'chr' or 'jo', or whatever. The space bar is strictly for moving the focus (the highlight) to the next section (from book to chapter, or from chapter to verse).

It doesn't come up with a list of results as you try to navigate. It simply produces the first, closest book to what you're typing, with that strictness I mentioned earlier.

This feature absolutely must be integrated in RhemaCast. I have gotten used to it and know how useful it is. It makes navigating through scriptures incredibly fast and efficient.

5. Theme designer is a tab in the index.html file I'm using as a draft to visualize the frontend of this app. In actuality, it will probably be under plugins, or a separate app, or an external website that runs in a browser. Most likely under plugins.

My vision for theme designer is as a result of the architectural decision to use a websocket connection to offload theme rendering to the system running the broadcast software. As we are sending code to the oher system, mere text, html, and javascript, we might as well take full advantage of the rendering power of that system.

Also, users can't all be expected to know HTML and CSS, so the theme designer will provide a user-friendly drag-and-drop interface to create and customize themes. Think Elementor.

6. If possible, I would like this app to behave more like a browswer than just having tabs like a broswer.

For snappy startup and better performance, how about the system loads just the presentation tab on startup, just like a browswer does? When user clicks on a tab, THEN it loads.

7. This is perhaps the most important part. I AM DEVELOPING ON A LINUX SYSTEM, BUT THIS APP IS TO RUN ON WINDOWS. I have to test this app locally, on Linux, but compile to Windows .exe (would be nice if this can be compiled to .deb too). This will be a bit complex because we're making heavy use of GPU. What a great time to be alive!






I will add more notes as time goes on and I think of them