import sys; sys.path.insert(0,'.')
from deck2_chogo import *
d=Deck('REBUILDER_통일교육_초등고학년','초등 고학년',PARTS,FS,PAL)
print(build(d,S,'../decks')); print('\n'.join(w for w in WARN))
